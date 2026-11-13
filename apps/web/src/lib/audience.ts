// Funções puras do seletor de público ("quem pode ver") de BIs, painéis e automações.

export type AudienceUser = { id: string; name: string; email: string };

/** Minúsculas e sem acentos: "araujo" encontra "Araújo". */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

/** Usuários que aparecem na grade: ordem por nome, filtro de busca (nome ou e-mail) e, se pedido, só os marcados. */
export function filterAudienceUsers<U extends AudienceUser>(
  users: U[],
  query: string,
  selectedIds: string[],
  onlySelected: boolean,
): U[] {
  const needle = normalizeSearch(query);
  const selected = new Set(selectedIds);
  return [...users]
    .filter((user) => !onlySelected || selected.has(user.id))
    .filter((user) => !needle || normalizeSearch(`${user.name} ${user.email}`).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Frase de resumo sob o seletor: deixa claro quem terá acesso, para nada ficar escondido numa aba. */
export function describeAudience(departmentNames: string[], userCount: number): string {
  const depts = departmentNames.join(', ');
  const people = `${userCount} ${userCount === 1 ? 'pessoa marcada' : 'pessoas marcadas'}`;
  if (departmentNames.length === 0 && userCount === 0) return 'Nada marcado: todos poderão ver.';
  if (userCount === 0) return `Terão acesso: ${depts} (o departamento inteiro).`;
  if (departmentNames.length === 0) return `Terão acesso somente ${userCount === 1 ? 'a' : 'às'} ${people}.`;
  return `Terão acesso: ${depts} (o departamento inteiro) + ${people}.`;
}

/** Texto curto para cartões e selos: "Todos", "2 dept.", "3 pessoas", "2 dept. + 3 pessoas". */
export function audienceBadge(departmentCount: number, userCount: number): string {
  if (departmentCount === 0 && userCount === 0) return 'Todos';
  const parts: string[] = [];
  if (departmentCount > 0) parts.push(`${departmentCount} dept.`);
  if (userCount > 0) parts.push(`${userCount} ${userCount === 1 ? 'pessoa' : 'pessoas'}`);
  return parts.join(' + ');
}
