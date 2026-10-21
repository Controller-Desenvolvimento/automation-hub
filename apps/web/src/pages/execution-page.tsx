import { Download, Eye, EyeOff, FileInput, FileSpreadsheet, Files, RefreshCw, SlidersHorizontal, SquareTerminal } from 'lucide-react';
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
  // Qual "rodar novamente" está em andamento (os dois botões ficam desabilitados enquanto um deles roda).
  const [retrying, setRetrying] = useState<'same' | 'output' | null>(null);

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
  // Quem executou e os administradores (a API confere de novo). O papel já vem "efetivo": Inovação conta como admin.
  const canRetry =
    (execution.status === 'error' || execution.status === 'canceled') &&
    (user?.role === 'admin' || (!!user && execution.userId === user.id));
  const outputFiles = execution.files.filter((file) => file.kind !== 'input');
  const inputFiles = execution.files.filter((file) => file.kind === 'input');
  // "Com a planilha final como entrada" só faz sentido se a execução recebeu uma planilha e deixou arquivos na saída.
  // Qual planilha da saída vale (às vezes dentro do output.zip) quem decide é a API.
  const canRetryWithOutput =
    canRetry &&
    outputFiles.length > 0 &&
    inputFiles.some((file) => /\.(xlsx|xlsm|xls)$/i.test(file.originalName ?? file.filename));

  async function handleRetry(mode: 'same' | 'output') {
    if (retrying) return;
    setRetrying(mode);
    try {
      const path = mode === 'output' ? 'retry-with-output' : 'retry';
      const retried = await api<Execution>(`/executions/${execution!.id}/${path}`, { method: 'POST' });
      notify(
        mode === 'output'
          ? 'Execução iniciada com a planilha final como entrada.'
          : 'Execução reiniciada com as mesmas entradas.',
      );
      await refreshHub();
      navigate(`/executions/${retried.id}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível reiniciar a execução.');
    } finally {
      setRetrying(null);
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
            <>
              <Button variant="outline" disabled={retrying !== null} onClick={() => void handleRetry('same')}>
                <RefreshCw className={`mr-2 h-4 w-4 ${retrying === 'same' ? 'animate-spin' : ''}`} />
                {retrying === 'same' ? 'Iniciando...' : 'Rodar novamente com as mesmas entradas'}
              </Button>
              {canRetryWithOutput ? (
                <Button
                  variant="outline"
                  disabled={retrying !== null}
                  title="Usa a planilha que esta execução deixou na saída (com o que já foi feito marcado) no lugar da enviada, para continuar de onde parou."
                  onClick={() => void handleRetry('output')}
                >
                  <FileSpreadsheet className={`mr-2 h-4 w-4 ${retrying === 'output' ? 'animate-pulse' : ''}`} />
                  {retrying === 'output' ? 'Iniciando...' : 'Rodar novamente com a planilha final como entrada'}
                </Button>
              ) : null}
            </>
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

      {/* Faixa inteira no fim da página: logs e arquivos de saída são o que mais se consulta e não dividem espaço com ela. */}
      <ParametersCard execution={execution} />
    </div>
  );
}

const SECRET_NAME_RE = /senha|password|passwd|secret|segredo|token/i;

function formatParameter(value: unknown, fieldType?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (fieldType === 'checkbox' && (value === 'true' || value === 'false')) return value === 'true' ? 'Sim' : 'Não';
  if (Array.isArray(value)) return value.length > 0 ? value.map((item) => String(item)).join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// O que foi informado ao rodar a automação. Quem executou e os administradores veem tudo, inclusive as senhas (escondidas
// por padrão, com um botão para mostrar): serve para achar "senha digitada errada" sem precisar ligar para o suporte.
// Para os outros usuários a API tira as senhas e elas aparecem aqui como "oculto".
function ParametersCard({ execution }: { execution: Execution }) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const fields = execution.robot.schema?.fields ?? [];
  const params = execution.inputJson ?? {};
  const hidden = execution.hiddenParameters ?? [];
  const fieldByName = new Map(fields.map((field) => [field.name, field]));

  // Primeiro os campos do formulário do robô (na ordem dele), depois o que sobrou.
  const names = [
    ...fields.map((field) => field.name).filter((name) => name in params || hidden.includes(name)),
    ...Object.keys(params).filter((name) => !fieldByName.has(name)),
    ...hidden.filter((name) => !fieldByName.has(name)),
  ].filter((name, index, all) => all.indexOf(name) === index);

  function toggle(name: string) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-slate-200 p-2 dark:border-slate-800">
            <SlidersHorizontal className="h-4 w-4 text-slate-500 dark:text-zinc-400" />
          </div>
          <div>
            <CardTitle>Parâmetros</CardTitle>
            <CardDescription>O que foi informado ao rodar esta automação.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {names.length === 0 ? (
          // Muitos robôs só usam os arquivos enviados (sem campos no formulário); sem este aviso o cartão sumia e parecia defeito.
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Esta automação não recebeu parâmetros: ela usa apenas os arquivos de entrada.
          </p>
        ) : null}
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {names.map((name) => {
            const field = fieldByName.get(name);
            const label = field?.label ?? name;
            const isHidden = hidden.includes(name);
            const isSecret = isHidden || field?.type === 'password' || SECRET_NAME_RE.test(name);
            const text = formatParameter(params[name], field?.type);
            const empty = text === '—';
            const show = revealed.has(name);
            // Valores longos (lista de empresas, observações) ocupam a linha toda em vez de espremer uma coluna.
            const wide = !isSecret && (text.length > 60 || text.includes('\n'));
            return (
              <div key={name} className={wide ? 'sm:col-span-2 xl:col-span-3' : undefined}>
                <dt className="text-xs font-medium text-slate-500 dark:text-zinc-400">{label}</dt>
                <dd className="mt-0.5 flex items-start justify-between gap-2 text-sm text-slate-900 dark:text-zinc-100">
                  {isHidden ? (
                    <span className="text-slate-500 dark:text-zinc-400">
                      Oculto — só quem executou e os administradores veem.
                    </span>
                  ) : isSecret && !empty ? (
                    <>
                      <span className={`min-w-0 break-all ${show ? 'font-mono' : 'tracking-widest'}`}>
                        {show ? text : '•'.repeat(Math.min(text.length, 24))}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggle(name)}
                        aria-label={show ? `Ocultar ${label}` : `Mostrar ${label}`}
                        title={show ? 'Ocultar' : 'Mostrar'}
                        className="shrink-0 rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                      >
                        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </>
                  ) : (
                    <span className={`min-w-0 whitespace-pre-wrap break-words ${empty ? 'text-slate-400 dark:text-zinc-500' : ''}`}>
                      {text}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
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
