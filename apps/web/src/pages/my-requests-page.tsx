import { Inbox, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/page-header';
import { RequestTypeSwitch } from '../components/request-type-switch';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import type { AutomationRequest } from '../lib/types';
import {
  automationRequestCadenceLabel,
  automationRequestStatusLabel,
  automationRequestStatusVariant,
  automationRequestUrgencyLabel,
  cn,
  formatDate,
} from '../lib/utils';

/** Pedidos de automação e de dashboard de quem está logado, com a situação e a mensagem da Inovação. */
export function MyRequestsPage() {
  const { notify } = useHub();
  const [requests, setRequests] = useState<AutomationRequest[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<AutomationRequest[]>('/automation-requests?mine=true');
        if (!cancelled) setRequests(data);
      } catch (error) {
        if (!cancelled && requests === null) {
          notify(error instanceof Error ? error.message : 'Não foi possível carregar os seus pedidos.');
          setRequests([]);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Meus <span className="text-sky-600 dark:text-sky-400">pedidos</span></>}
        description="Acompanhe o andamento dos seus pedidos de automação e de dashboard. Quando a Inovação recusa ou deixa um recado, ele aparece aqui."
      />

      <RequestTypeSwitch current="mine" />

      {requests === null ? (
        <div className="grid gap-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-28 animate-pulse rounded-3xl border border-slate-200 bg-slate-100 dark:border-[#27272a] dark:bg-slate-800/50" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <Card className="rounded-3xl">
          <CardContent className="py-14 text-center">
            <Inbox className="mx-auto mb-4 h-10 w-10 text-slate-300 dark:text-zinc-600" />
            <p className="text-sm text-slate-500 dark:text-zinc-400">Você ainda não fez nenhum pedido.</p>
            <Button asChild className="mt-4">
              <Link to="/automation-requests">
                <Send className="mr-2 h-4 w-4" />
                Fazer um pedido
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestRow({ request }: { request: AutomationRequest }) {
  const rejected = request.status === 'rejected';
  const hasUpdate = request.updatedAt && request.updatedAt !== request.createdAt;

  return (
    <Card className="rounded-3xl">
      <CardContent className="grid gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-950 dark:text-white">{request.title}</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
              Enviado em {formatDate(request.createdAt)}
              {request.systemName ? ` · ${request.systemName}` : ''}
              {` · Urgência ${automationRequestUrgencyLabel(request.urgency).toLowerCase()}`}
              {` · ${automationRequestCadenceLabel(request.cadence)}`}
            </p>
          </div>
          <Badge variant={automationRequestStatusVariant(request.status)}>{automationRequestStatusLabel(request.status)}</Badge>
        </div>

        <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-zinc-300">{request.description}</p>

        {request.statusNote ? (
          <div
            className={cn(
              'rounded-2xl border px-4 py-3 text-sm',
              rejected
                ? 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-100'
                : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-100',
            )}
          >
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] opacity-70">
              {rejected ? 'Motivo da recusa' : 'Recado da Inovação'}
            </div>
            <p className="whitespace-pre-wrap">{request.statusNote}</p>
          </div>
        ) : null}

        {hasUpdate ? (
          <p className="text-xs text-slate-400 dark:text-zinc-500">Atualizado em {formatDate(request.updatedAt)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
