import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storageRoot } from '../shared/storage';

// Estado do auto deploy (script infra/windows/deploy.ps1). Os dois lados conversam por
// arquivos em storage/ — sem tabela nova e sem depender de a API estar no ar:
//  - deploy-pending.json: o script grava quando há uma atualização da API esperando as
//    execuções terminarem. Enquanto existir, o runner NÃO inicia execuções novas (ficam na
//    fila) e o admin vê o aviso. O script apaga ao reiniciar.
//  - deploy-last.json: resultado do último deploy (ok / falhou / voltou pra versão anterior).
export const DEPLOY_PENDING_FILE = join(storageRoot, 'deploy-pending.json');
export const DEPLOY_LAST_FILE = join(storageRoot, 'deploy-last.json');

// Trava de segurança: se o script morrer e deixar o arquivo, a fila não pode ficar parada
// pra sempre. Passado esse tempo o pendente é ignorado.
export const DEPLOY_PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface DeployPending {
  sha: string;
  message: string;
  requestedAt: string;
  // O admin escolheu "Atualizar agora": as execuções em andamento foram canceladas.
  force?: boolean;
  forcedBy?: string;
}

export interface DeployLast {
  sha: string;
  status: 'ok' | 'failed' | 'rolled_back';
  kind: 'web' | 'api' | 'none';
  message: string;
  startedAt: string;
  finishedAt: string;
}

// Separado da leitura de arquivo pra poder testar sem disco.
export function parseDeployPending(raw: string, now = Date.now()): DeployPending | null {
  try {
    const data = JSON.parse(raw) as Partial<DeployPending>;
    if (!data || typeof data.sha !== 'string' || typeof data.requestedAt !== 'string') return null;
    const requested = Date.parse(data.requestedAt);
    if (Number.isNaN(requested) || now - requested > DEPLOY_PENDING_MAX_AGE_MS) return null;
    return {
      sha: data.sha,
      message: typeof data.message === 'string' ? data.message : '',
      requestedAt: data.requestedAt,
      force: data.force === true,
      forcedBy: typeof data.forcedBy === 'string' ? data.forcedBy : undefined,
    };
  } catch {
    return null;
  }
}

// Síncrono de propósito: o runner consulta isso a cada 3 s e um existsSync é praticamente de graça.
export function readDeployPendingSync(now = Date.now()): DeployPending | null {
  try {
    if (!existsSync(DEPLOY_PENDING_FILE)) return null;
    return parseDeployPending(readFileSync(DEPLOY_PENDING_FILE, 'utf8'), now);
  } catch {
    return null;
  }
}

export async function writeDeployPending(pending: DeployPending) {
  await writeFile(DEPLOY_PENDING_FILE, JSON.stringify(pending, null, 2), 'utf8');
}

export async function readDeployLast(): Promise<DeployLast | null> {
  try {
    const data = JSON.parse(await readFile(DEPLOY_LAST_FILE, 'utf8')) as Partial<DeployLast>;
    if (!data || typeof data.sha !== 'string' || typeof data.status !== 'string') return null;
    return data as DeployLast;
  } catch {
    return null;
  }
}
