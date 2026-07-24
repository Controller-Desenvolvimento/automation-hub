import { ArrowRight, Search, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppIcon } from '../components/app-icon';
import { PageHeader } from '../components/page-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';

export function RobotsPage() {
  const { user } = useAuth();
  const { hub, hubError, notify, refreshHub } = useHub();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({});
  const [pendingFavoriteIds, setPendingFavoriteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const categoryFilter = searchParams.get('category') ?? '';

  const robots = hub?.robots ?? [];

  // Filtro por categoria só faz sentido pra quem enxerga robôs de mais de um setor —
  // um usuário com um único departamento sempre veria uma categoria só.
  const canFilterByCategory =
    user?.role === 'admin' || (user?.departments.length ?? 0) > 1;

  const categories = useMemo(
    () =>
      [...new Set(robots.map((robot) => robot.category).filter(Boolean))]
        .map((item) => item as string)
        .sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [robots],
  );

  const filtered = useMemo(
    () =>
      robots
        .filter((robot) => {
          const term = query.trim().toLowerCase();
          const matchesSearch =
            !term ||
            robot.name.toLowerCase().includes(term) ||
            (robot.summary ?? '').toLowerCase().includes(term);
          const matchesCategory = !categoryFilter || (robot.category ?? '') === categoryFilter;
          return matchesSearch && matchesCategory;
        })
        .sort((left, right) => {
          const leftFavorite = favoriteOverrides[left.id] ?? Boolean(left.isFavorite);
          const rightFavorite = favoriteOverrides[right.id] ?? Boolean(right.isFavorite);
          if (leftFavorite !== rightFavorite) return rightFavorite ? 1 : -1;
          return (
            (left.category ?? '').localeCompare(right.category ?? '', 'pt-BR') ||
            left.name.localeCompare(right.name, 'pt-BR')
          );
        }),
    [robots, query, categoryFilter, favoriteOverrides],
  );

  async function toggleFavorite(robotId: string, currentValue: boolean) {
    if (pendingFavoriteIds.has(robotId)) return;

    const nextValue = !currentValue;
    setFavoriteOverrides((current) => ({ ...current, [robotId]: nextValue }));
    setPendingFavoriteIds((current) => new Set(current).add(robotId));

    try {
      await api(`/robots/${robotId}/favorite`, {
        method: nextValue ? 'POST' : 'DELETE',
      });
      await refreshHub();
      setFavoriteOverrides((current) => {
        const next = { ...current };
        delete next[robotId];
        return next;
      });
    } catch (error) {
      setFavoriteOverrides((current) => {
        const next = { ...current };
        delete next[robotId];
        return next;
      });
      notify(error instanceof Error ? error.message : 'Não foi possível atualizar o favorito.');
    } finally {
      setPendingFavoriteIds((current) => {
        const next = new Set(current);
        next.delete(robotId);
        return next;
      });
    }
  }

  if (!hub && hubError) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-950/20 dark:text-rose-400"
      >
        <span>Não foi possível carregar o catálogo de robôs.</span>
        <Button variant="outline" onClick={() => void refreshHub()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (!hub) {
    return (
      <div role="status" aria-live="polite" className="grid grid-cols-1 animate-pulse gap-6">
        <div className="h-8 w-64 rounded-lg bg-slate-200 dark:bg-slate-800" />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-52 rounded-3xl bg-slate-100 dark:bg-slate-800/50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Robôs <span className="text-sky-600 dark:text-sky-400">disponíveis</span></>}
        description="Navegue pelo catálogo central e abra a configuração de execução em poucos cliques."
      />

      <div className="flex flex-wrap gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-10 pl-9"
            placeholder="Buscar robô..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {canFilterByCategory ? (
          <div className="w-full sm:max-w-xs">
            <select
              className="flex h-10 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
              value={categoryFilter}
              onChange={(event) => {
                const value = event.target.value;
                const next = new URLSearchParams(searchParams);
                if (value) {
                  next.set('category', value);
                } else {
                  next.delete('category');
                }
                setSearchParams(next);
              }}
            >
              <option value="">Todas as categorias</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {filtered.map((robot) => {
          const isFavorite =
            favoriteOverrides[robot.id] ?? Boolean(robot.isFavorite);
          const isPending = pendingFavoriteIds.has(robot.id);

          return (
            <Card key={robot.id} className="flex flex-col rounded-3xl">
            <CardHeader className="flex-1 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <AppIcon icon={robot.icon} />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={
                      isFavorite
                        ? `Remover ${robot.name} dos favoritos`
                        : `Adicionar ${robot.name} aos favoritos`
                    }
                    title={isFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                    disabled={isPending}
                    onClick={() => void toggleFavorite(robot.id, isFavorite)}
                    className={[
                      'grid h-9 w-9 place-items-center rounded-xl border transition disabled:cursor-wait disabled:opacity-60',
                      isFavorite
                        ? 'border-amber-300 bg-amber-50 text-amber-500 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400'
                        : 'border-slate-200 text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-500 dark:border-[#2b2b31] dark:text-zinc-500 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10 dark:hover:text-amber-400',
                    ].join(' ')}
                  >
                    <Star className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
                  </button>
                  <Badge variant={robot.isActive ? 'success' : 'muted'}>
                    {robot.isActive ? 'Disponível' : 'Manutenção'}
                  </Badge>
                </div>
              </div>
              <div className="space-y-2">
                <CardTitle className="text-2xl">{robot.name}</CardTitle>
                <CardDescription>{robot.summary ?? 'Sem resumo cadastrado.'}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 gap-3 text-sm text-slate-500 dark:text-zinc-400">
                <div className="flex items-center justify-between gap-4">
                  <span>Categoria</span>
                  <span className="font-medium text-slate-700 dark:text-zinc-200">
                    {robot.category ?? 'Geral'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Versão</span>
                  <span className="font-medium text-slate-700 dark:text-zinc-200">v{robot.version}</span>
                </div>
              </div>

              <Button asChild className="w-full">
                <Link to={`/robots/${robot.slug}`}>
                  Abrir automação
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
            </Card>
          );
        })}

        {filtered.length === 0 ? (
          <div className="xl:col-span-3">
            <p className="text-sm text-slate-500 dark:text-zinc-400">
              {query ? `Nenhum robô encontrado para "${query}".` : 'Nenhum robô disponível nesta categoria.'}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
