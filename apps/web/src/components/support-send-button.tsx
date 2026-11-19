import { ChevronDown, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TicketStatus } from '../lib/support';
import { Button } from './ui/button';

export type SendOption = { label: string; status: TicketStatus };

/**
 * Botão "Enviar" com menu (para a Inovação): o clique principal só responde e mantém o status; o menu responde e já muda o status
 * ("Enviar e resolver", "Enviar e aguardar usuário"...). O texto fica na ação, sem um campo de status a mais.
 */
export function SendButton({
  onSend,
  options,
  disabled,
  sending,
  label = 'Enviar',
}: {
  onSend: (status?: TicketStatus) => void;
  options: SendOption[];
  disabled?: boolean;
  sending?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasMenu = options.length > 0;

  return (
    <div ref={box} className="relative inline-flex">
      <Button onClick={() => onSend()} disabled={disabled || sending} className={hasMenu ? 'rounded-r-none' : undefined}>
        <Send className="mr-2 h-4 w-4" />
        {sending ? 'Enviando...' : label}
      </Button>
      {hasMenu ? (
        <>
          <Button
            type="button"
            aria-label="Mais opções de envio"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled || sending}
            onClick={() => setOpen((current) => !current)}
            className="rounded-l-none border-l border-white/25 px-2.5 dark:border-slate-300"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          {open ? (
            <ul
              role="menu"
              className="absolute bottom-full left-0 z-30 mb-2 min-w-[280px] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-[#27272a] dark:bg-[#111113]"
            >
              {options.map((option) => (
                <li key={option.status} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-4 py-2.5 text-left text-sm text-slate-800 transition hover:bg-slate-50 dark:text-zinc-100 dark:hover:bg-white/[0.04]"
                    onClick={() => {
                      setOpen(false);
                      onSend(option.status);
                    }}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
