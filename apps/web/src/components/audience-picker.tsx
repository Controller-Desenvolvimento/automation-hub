import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useHub } from '../contexts/hub-context';
import { type AudienceUser, describeAudience, filterAudienceUsers } from '../lib/audience';
import { cn } from '../lib/utils';

const CARD_BASE = 'rounded-2xl border px-4 py-3 text-left text-sm transition';
const CARD_ON = 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-300';
const CARD_OFF =
  'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b]';

type Props = {
  /** Todos os usuários que podem ser escolhidos (a lista vem de /users, só para administradores). */
  users: AudienceUser[];
  selectedUsers: string[];
  onToggleUser: (userId: string) => void;
  selectedDepartments: string[];
  onToggleDepartment: (slug: string) => void;
  /** Título e dica próprios: o seletor NÃO deve ficar dentro de um <label> (o <Field> do projeto é um <label>). */
  label?: string;
  hint?: string;
  className?: string;
};

/**
 * "Quem pode ver": departamentos E pessoas, somados. As duas listas ficam marcadas ao mesmo tempo; as abas só
 * alternam qual delas aparece, cada uma com o contador do que já está marcado, e o resumo abaixo diz o resultado.
 */
export function AudiencePicker({ users, selectedUsers, onToggleUser, selectedDepartments, onToggleDepartment, label, hint, className }: Props) {
  const { departments } = useHub();
  const [tab, setTab] = useState<'departments' | 'users'>(
    selectedDepartments.length === 0 && selectedUsers.length > 0 ? 'users' : 'departments',
  );
  const [query, setQuery] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);

  const activeDepartments = departments.filter((d) => d.isActive);
  // Departamento marcado que não está mais na lista de ativos continua visível (para poder ser desmarcado).
  const orphanDepartments = selectedDepartments.filter((slug) => !activeDepartments.some((d) => d.slug === slug));
  const departmentNames = selectedDepartments.map((slug) => departments.find((d) => d.slug === slug)?.name ?? slug);

  const visibleUsers = useMemo(
    () => filterAudienceUsers(users, query, selectedUsers, onlySelected),
    [users, query, selectedUsers, onlySelected],
  );
  const selectedKnown = users.filter((user) => selectedUsers.includes(user.id)).length;

  const tabClass = (active: boolean) =>
    [
      'rounded-xl border px-4 py-2 text-sm font-medium transition',
      active ? CARD_ON : CARD_OFF,
    ].join(' ');

  return (
    <div className={cn('grid gap-3', className)}>
      {label && <span className="text-sm font-medium text-slate-700 dark:text-zinc-200">{label}</span>}
      <div role="tablist" aria-label="Quem pode ver" className="flex flex-wrap gap-2">
        <button type="button" role="tab" aria-selected={tab === 'departments'} className={tabClass(tab === 'departments')} onClick={() => setTab('departments')}>
          Departamentos ({selectedDepartments.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === 'users'} className={tabClass(tab === 'users')} onClick={() => setTab('users')}>
          Usuários específicos ({selectedUsers.length})
        </button>
      </div>

      <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-[#18181b] dark:text-zinc-300">
        {describeAudience(departmentNames, selectedUsers.length)}
      </p>

      {tab === 'departments' ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {activeDepartments.map((dept) => {
            const active = selectedDepartments.includes(dept.slug);
            return (
              <button key={dept.slug} type="button" aria-pressed={active} className={[CARD_BASE, active ? CARD_ON : CARD_OFF].join(' ')} onClick={() => onToggleDepartment(dept.slug)}>
                {dept.name}
              </button>
            );
          })}
          {orphanDepartments.map((slug) => (
            <button key={slug} type="button" aria-pressed className={[CARD_BASE, CARD_ON].join(' ')} onClick={() => onToggleDepartment(slug)}>
              {slug} <span className="text-xs opacity-70">(departamento inativo)</span>
            </button>
          ))}
          {activeDepartments.length === 0 && orphanDepartments.length === 0 && (
            <p className="col-span-full text-sm text-slate-500 dark:text-zinc-400">Nenhum departamento cadastrado.</p>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[16rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-zinc-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar usuário por nome ou e-mail…"
                aria-label="Buscar usuário"
                className="flex h-11 w-full rounded-2xl border border-slate-200 bg-white pl-10 pr-4 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-300">
              <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
              Mostrar só os marcados
            </label>
          </div>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            {selectedKnown} marcado{selectedKnown === 1 ? '' : 's'} · mostrando {visibleUsers.length} de {users.length}
            {selectedUsers.length > selectedKnown && ` · ${selectedUsers.length - selectedKnown} marcado(s) de contas que não existem mais`}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleUsers.map((user) => {
              const active = selectedUsers.includes(user.id);
              return (
                <button key={user.id} type="button" aria-pressed={active} className={[CARD_BASE, active ? CARD_ON : CARD_OFF].join(' ')} onClick={() => onToggleUser(user.id)}>
                  <div className="font-medium">{user.name}</div>
                  <div className="text-xs opacity-70">{user.email}</div>
                </button>
              );
            })}
            {users.length === 0 && <p className="col-span-full text-sm text-slate-500 dark:text-zinc-400">Nenhum usuário cadastrado.</p>}
            {users.length > 0 && visibleUsers.length === 0 && (
              <p className="col-span-full text-sm text-slate-500 dark:text-zinc-400">
                {onlySelected && !query ? 'Ninguém marcado ainda.' : 'Nenhum usuário encontrado para essa busca.'}
              </p>
            )}
          </div>
        </div>
      )}
      {hint && <span className="text-xs text-slate-500 dark:text-zinc-400">{hint}</span>}
    </div>
  );
}
