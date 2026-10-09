import { cn } from '../lib/utils';

// Skeleton da tela cheia de um painel (barra de cima, menu lateral, título,
// cartões e gráfico). A MESMA estrutura e medidas existem em index.html (a
// cobertura criada antes do React no F5): mexeu aqui, ajuste lá também, senão
// aparece um "salto" na troca.
const BLOCK = 'animate-pulse rounded-xl bg-[#e8edf3] dark:bg-[#1f1f24]';
const SHAPE = 'animate-pulse rounded-lg bg-[#d9e1ea] dark:bg-[#2e2e35]';

export function PanelSkeletonBody({ className }: { className?: string }) {
  return (
    <div className={cn('flex bg-white dark:bg-[#0a0a0b]', className)} aria-hidden="true">
      <div className="hidden w-[198px] shrink-0 space-y-3 border-r border-slate-200 p-3 dark:border-[#2b2b31] md:block">
        <div className={cn(BLOCK, 'h-[72px]')} />
        <div className="space-y-2.5 pt-4">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={cn(BLOCK, 'h-[46px]')} />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-5 overflow-hidden p-6">
        <div className="space-y-2">
          <div className={cn(SHAPE, 'h-7 w-80 max-w-full')} />
          <div className={cn(SHAPE, 'h-3.5 w-28')} />
        </div>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={cn(BLOCK, 'h-[88px] rounded-2xl')} />
          ))}
        </div>
        <div className={cn(BLOCK, 'h-[360px] rounded-2xl')} />
        <div className={cn(BLOCK, 'h-40 rounded-2xl')} />
      </div>
    </div>
  );
}

// Versão completa (com a barra do visualizador), usada enquanto os dados dos painéis carregam.
export function PanelSkeleton() {
  return (
    <div role="status" aria-label="Carregando painel" className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-[#0a0a0b]">
      <div className="flex h-[49px] shrink-0 items-center gap-3 border-b border-slate-200 px-4 dark:border-[#2b2b31]">
        <div className={cn(SHAPE, 'h-4 w-56')} />
        <div className="flex-1" />
        <div className={cn(SHAPE, 'h-6 w-6')} />
      </div>
      <PanelSkeletonBody className="min-h-0 flex-1" />
    </div>
  );
}
