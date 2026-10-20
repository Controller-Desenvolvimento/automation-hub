import * as React from 'react';
import { cn } from '../../lib/utils';

// Campo de arquivo: o botão nativo ("Escolher arquivo") é mais alto que o texto do campo e, com o padding
// de um input comum, ficava torto (colado no alto, caixa apertada). Aqui a caixa cresce com o botão, tudo
// é centralizado na vertical e o botão ganha o mesmo visual dos botões secundários do sistema.
const fileInputClasses =
  'h-auto min-h-10 cursor-pointer items-center py-1.5 pl-1.5 pr-4 text-slate-500 dark:text-zinc-400 ' +
  'file:mr-3 file:inline-flex file:h-7 file:cursor-pointer file:items-center file:rounded-lg file:border-0 ' +
  'file:bg-slate-100 file:px-3 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200 ' +
  'dark:file:bg-[#27272a] dark:file:text-zinc-100 dark:hover:file:bg-[#323238]';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 [color-scheme:light] dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:[color-scheme:dark]',
        type === 'file' && fileInputClasses,
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';
