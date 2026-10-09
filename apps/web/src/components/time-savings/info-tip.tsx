import { Info } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Tooltip acessível (abre com hover e com foco de teclado) para explicar um
// indicador sem ocupar espaço fixo na tela.
export function InfoTip({
  label,
  children,
  align = 'start',
  className,
}: {
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const id = useId();

  return (
    <span className={cn('group relative inline-flex align-middle', className)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="rounded-full p-0.5 text-slate-400 transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 dark:text-zinc-500 dark:hover:text-zinc-200"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span
        role="tooltip"
        id={id}
        className={cn(
          // `hidden` (e não invisible): tooltips invisíveis ainda ampliam a rolagem horizontal da página.
          'pointer-events-none absolute top-full z-30 mt-2 hidden w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-slate-600 shadow-lg max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:w-auto',
          'group-hover:block group-focus-within:block',
          'dark:border-[#2b2b31] dark:bg-[#18181b] dark:text-zinc-300',
          align === 'end' ? 'right-0' : 'left-0',
        )}
      >
        {children}
      </span>
    </span>
  );
}
