import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

// Popover simples: fecha ao clicar fora ou com Esc. Radix Popover não faz parte
// das dependências do projeto, e este caso não justifica adicionar uma.
export function Popover({
  trigger,
  children,
  align = 'start',
  panelClassName,
}: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (controls: { close: () => void }) => ReactNode;
  align?: 'start' | 'end';
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((prev) => !prev) })}
      {open && (
        <div
          className={cn(
            'absolute z-30 mt-2 min-w-[260px] rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-[#2b2b31] dark:bg-[#141416]',
            align === 'end' ? 'left-0 sm:left-auto sm:right-0' : 'left-0',
            panelClassName,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
