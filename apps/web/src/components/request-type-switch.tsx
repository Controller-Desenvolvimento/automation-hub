import { LayoutDashboard, MessageSquarePlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';

const OPTIONS = [
  { key: 'automation', to: '/automation-requests', label: 'Automação', icon: MessageSquarePlus },
  { key: 'dashboard', to: '/dashboard-requests', label: 'Dashboard', icon: LayoutDashboard },
] as const;

/** Escolha do que se quer solicitar: o menu lateral tem um só "Solicitar" e a pessoa troca o tipo aqui. */
export function RequestTypeSwitch({ current }: { current: 'automation' | 'dashboard' }) {
  return (
    <div className="flex w-fit gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1 dark:border-[#27272a] dark:bg-[#111113]">
      {OPTIONS.map(({ key, to, label, icon: Icon }) => (
        <Link
          key={key}
          to={to}
          aria-current={current === key ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
            current === key
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
              : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </div>
  );
}
