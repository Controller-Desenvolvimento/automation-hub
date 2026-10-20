import { Download, FileInput, Files, RefreshCw, SquareTerminal } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { Separator } from '../components/ui/separator';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { api, downloadWithFeedback, isTransientError } from '../lib/api';
import type { Execution } from '../lib/types';
import { formatDate, statusLabel, statusVariant, userFileName } from '../lib/utils';
import { useNavigate, useParams } from 'react-router-dom';

export function ExecutionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify, refreshHub } = useHub();
  const [execution, setExecution] = useState<Execution | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Falha passageira ao atualizar (hub reiniciando, 502, rede): a tela fica como está e tenta de novo.
  const [connectionLost, setConnectionLost] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async (finalCheck = false) => {
      if (!id) return;
      try {
        const data = await api<Execution>(`/executions/${id}`);
        if (!cancelled) {
          setExecution(data);
          setLoadError(null);
          setConnectionLost(false);
          if (data.status === 'queued' || data.status === 'running') {
            timer = window.setTimeout(() => void load(), 2500);
          } else if (!finalCheck) {
            timer = window.setTimeout(() => void load(true), 5000);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (isTransientError(err)) {
          // Antes qualquer falha trocava a página inteira pelo erro (com o HTML cru do IIS) e PARAVA de atualizar.
          setConnectionLost(true);
          timer = window.setTimeout(() => void load(finalCheck), 5000);
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'Não foi possível carregar a execução.');
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [id]);

  const logCount = execution?.logs.length ?? 0;
  useEffect(() => {
    // Só auto-scrolla quando chega log novo E o usuário já estava no fundo —
    // senão quem rolou para cima para ler é puxado de volta a cada poll
    if (logCount === 0) return;
    const terminal = document.querySelector('[data-terminal]');
    if (terminal instanceof HTMLElement) {
      const nearBottom =
        terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 80;
      if (nearBottom) {
        terminal.scrollTop = terminal.scrollHeight;
      }
    }
  }, [logCount]);

  const connectionBanner = connectionLost ? (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-300"
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
      Conexão com o servidor interrompida (ele pode estar reiniciando). Tentando de novo a cada poucos segundos.
    </div>
  ) : null;

  if (loadError) {
    return (
      <div role="status" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-950/20 dark:text-rose-400">
        {loadError}
      </div>
    );
  }

  if (!execution) {
    return (
      <div role="status" aria-live="polite" className="grid grid-cols-1 gap-6">
        {connectionBanner}
        <div className="h-8 w-72 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
        <div className="h-32 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800/50" />
        <div className="h-96 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800/50" />
      </div>
    );
  }

  const isLive = execution.status === 'queued' || execution.status === 'running';
  const canRetry =
    (execution.status === 'error' || execution.status === 'canceled') && user?.role === 'admin';
  const outputFiles = execution.files.filter((file) => file.kind !== 'input');
  const inputFiles = execution.files.filter((file) => file.kind === 'input');

  async function handleRetry() {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      const retried = await api<Execution>(`/executions/${execution!.id}/retry`, { method: 'POST' });
      notify('Execução reiniciada com as mesmas entradas.');
      await refreshHub();
      navigate(`/executions/${retried.id}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível reiniciar a execução.');
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      {connectionBanner}
      <PageHeader
        title={execution.robot.name}
        description={`${execution.requestedByName || execution.requestedByEmail || 'Usuário interno'} · ${formatDate(execution.startedAt || execution.createdAt)}`}
        badge={<Badge variant={statusVariant(execution.status)}>{statusLabel(execution.status)}</Badge>}
        actions={
          isLive ? (
            <Button
              variant="danger"
              disabled={isCanceling}
              onClick={async () => {
                setIsCanceling(true);
                try {
                  await api(`/executions/${execution.id}/cancel`, { method: 'POST' });
                  notify('Execução cancelada.');
                  await refreshHub();
                } catch (err) {
                  notify(err instanceof Error ? err.message : 'Não foi possível cancelar a execução.');
                } finally {
                  setIsCanceling(false);
                }
              }}
            >
              {isCanceling ? 'Cancelando...' : 'Cancelar execução'}
            </Button>
          ) : canRetry ? (
            <Button variant="outline" disabled={isRetrying} onClick={() => void handleRetry()}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isRetrying ? 'animate-spin' : ''}`} />
              {isRetrying ? 'Reiniciando...' : 'Reiniciar com mesmas entradas'}
            </Button>
          ) : null
        }
      />

      <Card className="rounded-3xl">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Andamento</CardTitle>
              <CardDescription>{execution.currentStep || 'Aguardando início'}</CardDescription>
            </div>
            <span className="text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">{execution.progress}%</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={execution.progress} />
          <div className="flex flex-wrap gap-4 text-sm text-slate-500 dark:text-zinc-400">
            <span>Criado em {formatDate(execution.createdAt)}</span>
            {execution.finishedAt ? <span>Finalizado em {formatDate(execution.finishedAt)}</span> : null}
            {execution.errorMessage ? <span className="text-rose-500">Erro: {execution.errorMessage}</span> : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="overflow-hidden rounded-3xl">
          <CardHeader className="border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="rounded-xl border border-slate-200 p-2 dark:border-slate-800">
                <SquareTerminal className="h-4 w-4 text-slate-500 dark:text-zinc-400" />
              </div>
              <div>
                <CardTitle>Logs em tempo real</CardTitle>
                <CardDescription>Fluxo vivo do stdout e stderr processado pelo runner.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div
              data-terminal
              className="h-[min(65vh,560px)] overflow-y-auto bg-[#090b10] px-5 py-4 font-mono text-sm leading-7 text-emerald-300"
            >
              {execution.logs.length > 0
                ? execution.logs.map((log) => (
                    <div key={log.id}>
                      <span className="text-slate-500">[{new Date(log.timestamp).toLocaleTimeString('pt-BR')}]</span>{' '}
                      <span className="text-sky-300">{log.level.toUpperCase()}</span>: {log.message}
                    </div>
                  ))
                : '[aguardando] Ainda não há logs.'}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-6">
          <FileCard
            title="Arquivos de saída"
            description="Downloads gerados nesta execução."
            icon={<Files className="h-4 w-4 text-slate-500 dark:text-zinc-400" />}
            files={outputFiles}
            emptyText="Ainda não há arquivos de saída disponíveis."
          />

          <FileCard
            title="Arquivos de entrada"
            description="Arquivos enviados pelo solicitante."
            icon={<FileInput className="h-4 w-4 text-slate-500 dark:text-zinc-400" />}
            files={inputFiles}
            emptyText="Esta execução não recebeu arquivos enviados."
          />
        </div>
      </div>
    </div>
  );
}

function FileCard({
  title,
  description,
  icon,
  files,
  emptyText,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  files: Execution['files'];
  emptyText: string;
}) {
  const { notify } = useHub();

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-slate-200 p-2 dark:border-slate-800">{icon}</div>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {files.length > 0 ? (
          files.map((file, index) => (
            <div key={file.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {userFileName(file.downloadName || file.originalName || file.filename)}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-zinc-400">{file.kind === 'input' ? 'Entrada' : 'Saída'}</div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void downloadWithFeedback(file.downloadUrl, userFileName(file.downloadName || file.originalName || file.filename), notify)}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Baixar
                </Button>
              </div>
              {index < files.length - 1 ? <Separator className="mt-4" /> : null}
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-zinc-400">
            {emptyText}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
