import { BadRequestException } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { basename, extname, normalize, sep } from 'node:path';

/**
 * Campos `serverpath` do schema dos robôs: o usuário escolhe uma pasta/arquivo
 * que o SERVIDOR enxerga (ex.: unidade X:) e o robô recebe só o caminho.
 *
 * A letra da unidade não fica conectada no processo do hub, então ela é traduzida
 * para o caminho de rede via `SERVER_PATH_DRIVES` no .env, ex.:
 *   SERVER_PATH_DRIVES=X=\\servidor\Dados
 * (vários separados por `;`). Nada disso vai pro git — fica só no .env.
 */

export type ServerPathField = {
  name: string;
  label?: string;
  type?: string;
  rootPath?: string;
  pick?: 'file' | 'folder';
  accept?: string;
};

export type ServerPathEntry = {
  name: string;
  kind: 'dir' | 'file';
  path: string;
};

export type ServerPathListing = {
  root: string;
  current: string;
  parent: string | null;
  entries: ServerPathEntry[];
  truncated: boolean;
};

const MAX_ENTRIES = 1000;

function drives(): Array<{ letter: string; unc: string }> {
  return (process.env.SERVER_PATH_DRIVES ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf('=');
      return {
        letter: item.slice(0, index).trim().replace(/:$/, '').toUpperCase(),
        unc: normalize(item.slice(index + 1).trim()).replace(/[\\/]+$/, ''),
      };
    })
    .filter((drive) => drive.letter.length === 1 && drive.unc.length > 0);
}

function clean(path: string) {
  return path.trim().replace(/^["']+|["']+$/g, '').trim().replaceAll('/', '\\');
}

/** `X:\pasta` → `\\servidor\Dados\pasta` (outros caminhos passam só normalizados). */
export function expandDrive(path: string): string {
  const cleaned = clean(path);
  const match = /^([a-zA-Z]):(?:\\|$)/.exec(cleaned);

  if (match) {
    const drive = drives().find((item) => item.letter === match[1].toUpperCase());
    if (drive) {
      return normalize(drive.unc + cleaned.slice(2)).replace(/[\\/]+$/, '');
    }
  }

  return normalize(cleaned).replace(/[\\/]+$/, '');
}

/** `\\servidor\Dados\pasta` → `X:\pasta` (o que o usuário reconhece). */
export function toDisplay(unc: string): string {
  const lower = unc.toLowerCase();

  for (const drive of drives()) {
    const base = drive.unc.toLowerCase();
    if (lower === base) return `${drive.letter}:\\`;
    if (lower.startsWith(base + sep)) return `${drive.letter}:${unc.slice(drive.unc.length)}`;
  }

  return unc;
}

/** Caminho resolvido (UNC) se `requested` estiver dentro de `root`; senão `null`. */
export function resolveWithinRoot(root: string, requested: string): string | null {
  const rootResolved = expandDrive(root);
  const target = requested.trim() ? expandDrive(requested) : rootResolved;

  const rootLower = rootResolved.toLowerCase();
  const targetLower = target.toLowerCase();

  if (targetLower === rootLower || targetLower.startsWith(rootLower + sep)) {
    return target;
  }

  return null;
}

export function getServerPathFields(schema: unknown): ServerPathField[] {
  const fields = (schema as { fields?: unknown } | null | undefined)?.fields;
  if (!Array.isArray(fields)) return [];

  return fields.filter(
    (field): field is ServerPathField =>
      !!field && typeof field === 'object' && (field as ServerPathField).type === 'serverpath',
  );
}

function allowedExtensions(accept?: string) {
  return (accept ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export async function listServerPath(field: ServerPathField, requested: string): Promise<ServerPathListing> {
  if (!field.rootPath) {
    throw new BadRequestException('Campo sem pasta raiz configurada.');
  }

  const rootResolved = expandDrive(field.rootPath);
  const target = resolveWithinRoot(field.rootPath, requested);

  if (!target) {
    throw new BadRequestException('Caminho fora da área permitida para este campo.');
  }

  const extensions = allowedExtensions(field.accept);
  const wantsFiles = field.pick === 'file';

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch {
    throw new BadRequestException(
      'Não foi possível abrir essa pasta no servidor (não existe ou o servidor não tem acesso).',
    );
  }

  const entries: ServerPathEntry[] = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    if (name.startsWith('$') || name.startsWith('~$') || name.startsWith('.')) continue;

    const full = normalize(`${target}${sep}${name}`);

    if (dirent.isDirectory()) {
      entries.push({ name, kind: 'dir', path: toDisplay(full) });
    } else if (wantsFiles && dirent.isFile()) {
      if (extensions.length > 0 && !extensions.includes(extname(name).toLowerCase())) continue;
      entries.push({ name, kind: 'file', path: toDisplay(full) });
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' });
  });

  const atRoot = target.toLowerCase() === rootResolved.toLowerCase();
  const parentResolved = atRoot ? null : normalize(`${target}${sep}..`);

  return {
    root: toDisplay(rootResolved),
    current: toDisplay(target),
    parent: parentResolved && resolveWithinRoot(field.rootPath, parentResolved) ? toDisplay(parentResolved) : null,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  };
}

/** Garante, na criação da execução, que cada campo `serverpath` aponta para dentro da sua raiz. */
export function validateServerPathParameters(schema: unknown, parameters: Record<string, unknown> | undefined) {
  for (const field of getServerPathFields(schema)) {
    const raw = parameters?.[field.name];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!value) continue;

    if (!field.rootPath || !resolveWithinRoot(field.rootPath, value)) {
      throw new BadRequestException(
        `O caminho informado em "${field.label || field.name}" está fora da área permitida (${basename(field.rootPath ?? '') || 'raiz'}).`,
      );
    }
  }
}
