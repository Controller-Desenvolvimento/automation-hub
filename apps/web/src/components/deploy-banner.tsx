import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import { timeAgo } from '../lib/utils';
import { Button } from './ui/button';

interface DeployStatus {
  pending: { sha: string; message: string; requestedAt: string; force?: boolean } | null;
  running: { id: string; robotName: string; startedAt: string | null }[];
  queued: number;
  last: { sha: string; status: 'ok' | 'failed' | 'rolled_back'; kind: string; message: string; finishedAt: string } | null;
}

const DISMISS_KEY = 'deploy-banner-dismissed';
const POLL_MS = 15_000;

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

// Aviso só pra admin sobre o auto deploy do servidor (ver apps/api/src/system/deploy-state.ts):
//  - atualização da API esperando as execuções terminarem (com a opção de atualizar já);
//  - a última atualização que falhou ou voltou pra versão anterior.
export function DeployBanner() {
  const { user } = useAuth();
  const { notify } = useHub();
  const canSee = user?.role === 'admin' || user?.departments.includes('inovacao') === true;
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [forcing, setForcing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<DeployStatus>('/system/deploy'));
    } catch {
      // sem permissão ou servidor reiniciando: o aviso só some até o próximo ciclo
    }
  }, []);

  useEffect(() => {
    if (!canSee) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [canSee, refresh]);

  async function forceNow() {
    const n = status?.running.length ?? 0;
    const ok = window.confirm(
      n > 0
        ? `Atualizar agora vai CANCELAR ${n} execução(ões) em andamento. Continuar?`
        : 'Atualizar o servidor agora?',
    );
    if (!ok) return;
    setForcing(true);
    try {
      await api('/system/deploy/force', { method: 'POST' });
      notify('Atualização liberada: o servidor reinicia em instantes.');
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível liberar a atualização.');
    } finally {
      setForcing(false);
    }
  }

  function dismiss(finishedAt: string) {
    setDismissed(finishedAt);
    try {
      window.localStorage.setItem(DISMISS_KEY, finishedAt);
    } catch {
      // sem storage: só some até recarregar
    }
  }

  if (!canSee || !status) return null;

  if (status.pending) {
    const { running, queued, pending } = status;
    return (
      <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <RefreshCw className="h-4 w-4 shrink-0 animate-spin [animation-duration:3s]" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {pending.force
                ? 'Atualização liberada: o servidor reinicia em instantes.'
                : running.length > 0
                  ? `Atualização do servidor aguardando ${running.length} execução(ões) terminarem`
                  : 'Atualização do servidor começando agora'}
            </div>
            <div className="text-xs opacity-80">
              {running.length > 0 && !pending.force
                ? `${running.map((r) => r.robotName).join(', ')}. `
                : ''}
              Novas execuções ficam na fila{queued > 0 ? ` (${queued} aguardando)` : ''} e começam logo depois do reinício.
              {pending.message ? ` Versão: ${pending.message}` : ''}
            </div>
          </div>
          {!pending.force ? (
            <Button
              variant="outline"
              size="sm"
              disabled={forcing}
              onClick={() => void forceNow()}
              className="shrink-0 border-amber-400 bg-white/70 text-amber-950 hover:bg-white dark:border-amber-500/40 dark:bg-transparent dark:text-amber-100"
            >
              Atualizar agora (cancela as execuções)
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const last = status.last;
  if (last && last.status !== 'ok' && dismissed !== last.finishedAt) {
    return (
      <div role="alert" className="border-b border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-950 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-100 sm:px-6 lg:px-8">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {last.status === 'rolled_back'
                ? 'A última atualização do servidor deu problema e voltou para a versão anterior'
                : 'A última atualização do servidor falhou'}
            </div>
            <div className="text-xs opacity-80">
              {last.message} · {last.sha.slice(0, 7)} · {timeAgo(last.finishedAt)}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dispensar aviso"
            onClick={() => dismiss(last.finishedAt)}
            className="rounded-lg p-1 hover:bg-rose-100 dark:hover:bg-rose-900/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
