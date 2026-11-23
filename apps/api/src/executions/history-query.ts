import { ExecutionStatus, Prisma } from '@prisma/client';

export type HistoryOrigin = 'all' | 'manual' | 'scheduled';

export type HistoryQuery = {
  page: number;
  pageSize: number;
  statuses: ExecutionStatus[];
  origin: HistoryOrigin;
  robotId?: string;
  q?: string;
  from?: Date;
  to?: Date;
};

export const HISTORY_MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;
const VALID_STATUSES = new Set<string>(Object.values(ExecutionStatus));

function text(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function intOr(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(text(value));
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// AAAA-MM-DD no fuso do servidor (o mesmo da Saúde dos robôs, que filtra por createdAt).
function day(value: unknown, endOfDay: boolean): Date | undefined {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Valores inválidos viram o padrão (nunca 400): a tela pode estar em cache com uma versão antiga. */
export function parseHistoryQuery(raw: Record<string, unknown>): HistoryQuery {
  const statuses = (text(raw.status) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ExecutionStatus => VALID_STATUSES.has(s));
  const origin = text(raw.origin);

  return {
    page: intOr(raw.page, 1, 1, 100_000),
    pageSize: intOr(raw.pageSize, DEFAULT_PAGE_SIZE, 1, HISTORY_MAX_PAGE_SIZE),
    statuses: [...new Set(statuses)],
    origin: origin === 'manual' || origin === 'scheduled' ? origin : 'all',
    robotId: text(raw.robotId),
    q: text(raw.q)?.slice(0, 100),
    from: day(raw.from, false),
    to: day(raw.to, true),
  };
}

/** Filtros que não dependem de status nem de origem (base das contagens das abas e do filtro de status). */
export function historyBaseWhere(query: HistoryQuery): Prisma.ExecutionWhereInput {
  const and: Prisma.ExecutionWhereInput[] = [];
  if (query.robotId) and.push({ robotId: query.robotId });
  if (query.from || query.to) {
    and.push({ createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } });
  }
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { requestedByName: contains },
        { requestedByEmail: contains },
        { currentStep: contains },
        { robot: { name: contains } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

export function historyOriginWhere(origin: HistoryOrigin): Prisma.ExecutionWhereInput {
  if (origin === 'scheduled') return { scheduledTaskId: { not: null } };
  if (origin === 'manual') return { scheduledTaskId: null };
  return {};
}
