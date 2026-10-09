import { Injectable } from '@nestjs/common';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface SystemSettings {
  runnerMaxConcurrency: number;
  runnerMemoryThreshold: number;
  executionRetentionDays: number;
  executionRetentionDaysWithOutput: number;
}

@Injectable()
export class SystemService {
  private get envPath() {
    // __dirname em produção: dist/src/system/ → subir 3 níveis chega em apps/api/
    return join(__dirname, '../../../.env');
  }

  getSettings(): SystemSettings {
    return {
      runnerMaxConcurrency: getEnvInt('RUNNER_MAX_CONCURRENCY', 2),
      runnerMemoryThreshold: getEnvInt('RUNNER_MEMORY_THRESHOLD_PERCENT', 90),
      executionRetentionDays: getEnvInt('EXECUTION_RETENTION_DAYS', 30),
      executionRetentionDaysWithOutput: getEnvInt('EXECUTION_RETENTION_DAYS_WITH_OUTPUT', 90),
    };
  }

  async updateSettings(input: Partial<SystemSettings>): Promise<SystemSettings> {
    const updates: Record<string, string> = {};

    if (input.runnerMaxConcurrency !== undefined) {
      const val = Math.max(1, Math.min(10, Math.floor(input.runnerMaxConcurrency)));
      updates['RUNNER_MAX_CONCURRENCY'] = String(val);
    }
    if (input.runnerMemoryThreshold !== undefined) {
      const val = Math.max(50, Math.min(99, Math.floor(input.runnerMemoryThreshold)));
      updates['RUNNER_MEMORY_THRESHOLD_PERCENT'] = String(val);
    }
    if (input.executionRetentionDays !== undefined) {
      const val = Math.max(0, Math.floor(input.executionRetentionDays));
      updates['EXECUTION_RETENTION_DAYS'] = String(val);
    }
    if (input.executionRetentionDaysWithOutput !== undefined) {
      const val = Math.max(0, Math.floor(input.executionRetentionDaysWithOutput));
      updates['EXECUTION_RETENTION_DAYS_WITH_OUTPUT'] = String(val);
    }

    for (const [key, value] of Object.entries(updates)) {
      process.env[key] = value;
    }

    await this.persistToEnv(updates);

    return this.getSettings();
  }

  async browseDir(dirPath?: string): Promise<{ current: string | null; parent: string | null; dirs: string[]; roots: string[] }> {
    const roots: string[] = [];
    if (process.platform === 'win32') {
      const checks = await Promise.all(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (l) => {
          const drive = `${l}:\\`;
          try { await stat(drive); return drive; } catch { return null; }
        }),
      );
      roots.push(...checks.filter((r): r is string => r !== null));
    } else {
      roots.push('/');
    }

    if (!dirPath) {
      return { current: null, parent: null, dirs: [], roots };
    }

    const current = resolve(dirPath);
    const parentPath = dirname(current);
    const parent = parentPath !== current ? parentPath : null;

    let dirs: string[] = [];
    try {
      const entries = await readdir(current, { withFileTypes: true });
      dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => join(current, e.name))
        .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    } catch { /* caminho inacessível — retorna vazio */ }

    return { current, parent, dirs, roots };
  }

  private async persistToEnv(updates: Record<string, string>) {
    let content = await readFile(this.envPath, 'utf8').catch(() => '');

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content = content.trimEnd() + `\n${key}=${value}\n`;
      }
    }

    await writeFile(this.envPath, content, 'utf8');
  }
}

function getEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  const raw = Number(val);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}
