import { Link2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { subjectText, type TicketRow } from '../lib/support';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/** Junta chamados que são o mesmo problema: escolhe-se o principal (por padrão o mais antigo) e responde-se uma vez nele. */
export function SupportMergeDialog({
  tickets,
  onClose,
  onMerged,
}: {
  tickets: TicketRow[];
  onClose: () => void;
  onMerged: (mainId: string, linkedCount: number) => void | Promise<void>;
}) {
  // Quem já está ligado a outro chamado não pode ser o principal.
  const candidates = useMemo(() => tickets.filter((t) => !t.mainTicketId).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt)), [tickets]);
  const [mainId, setMainId] = useState(candidates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function confirm() {
    if (!mainId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const others = tickets.filter((t) => t.id !== mainId).map((t) => t.id);
      await api('/support/tickets/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mainId, ticketIds: others }),
      });
      await onMerged(mainId, others.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível juntar os chamados.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button type="button" aria-label="Fechar" className="absolute inset-0 bg-black/50" onClick={() => !busy && onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
        className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-[#27272a] dark:bg-[#111113]"
      >
        <h2 id="merge-title" className="flex items-center gap-2 text-lg font-semibold text-slate-950 dark:text-white">
          <Link2 className="h-5 w-5 text-sky-500" />
          Juntar chamados
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
          Escolha o chamado principal. Você responde uma vez nele e a resposta (com os anexos) chega na conversa de cada pessoa. O status do principal vale para todos.
          Cada pessoa continua vendo só o próprio chamado.
        </p>

        <fieldset className="mt-4 grid gap-2">
          <legend className="sr-only">Chamado principal</legend>
          {tickets.map((t) => {
            const disabled = !!t.mainTicketId;
            return (
              <label
                key={t.id}
                className={cn(
                  'flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm',
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  mainId === t.id ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30' : 'border-slate-200 dark:border-[#2b2b31]',
                )}
              >
                <input type="radio" name="main" className="mt-1 accent-sky-600" disabled={disabled} checked={mainId === t.id} onChange={() => setMainId(t.id)} />
                <span className="min-w-0">
                  <span className="block font-medium text-slate-900 dark:text-zinc-100">
                    #{t.number} {t.title}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-zinc-400">
                    {t.author?.name ?? ''} · {subjectText(t)}
                    {disabled ? ' · já está ligado a outro (não pode ser o principal)' : mainId === t.id ? ' · principal' : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={() => void confirm()} disabled={busy || !mainId || tickets.length < 2}>
            {busy ? 'Juntando...' : `Juntar ${tickets.length} chamados`}
          </Button>
        </div>
      </div>
    </div>
  );
}
