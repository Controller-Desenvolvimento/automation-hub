// Regras puras do Suporte (chamados): sem banco, sem arquivos. Testadas em test/support-rules.test.ts.

export const TICKET_TYPES = ['problem', 'suggestion', 'question'] as const;
export const TICKET_SUBJECTS = ['hub', 'robot', 'dashboard', 'other'] as const;
export const TICKET_URGENCIES = ['critical', 'high', 'medium', 'low'] as const;
export const TICKET_STATUSES = ['open', 'review', 'waiting', 'resolved', 'not_issue'] as const;

export type TicketType = (typeof TICKET_TYPES)[number];
export type TicketSubject = (typeof TICKET_SUBJECTS)[number];
export type TicketUrgency = (typeof TICKET_URGENCIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Chamados "em aberto": ainda precisam de alguém (a Inovação ou quem abriu). */
export const OPEN_STATUSES: readonly TicketStatus[] = ['open', 'review', 'waiting'];
export const CLOSED_STATUSES: readonly TicketStatus[] = ['resolved', 'not_issue'];

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Aberto',
  review: 'Em análise',
  waiting: 'Aguardando resposta',
  resolved: 'Resolvido',
  not_issue: 'Não é problema',
};

export const URGENCY_LABELS: Record<TicketUrgency, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

export const MAX_TITLE = 120;
export const MAX_BODY = 5000;
export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MERGE_WINDOW_DAYS = 14;
export const MAX_MERGE = 50;

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isClosed(status: TicketStatus) {
  return CLOSED_STATUSES.includes(status);
}

// ---------- lista paginada ----------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type ListQuery = {
  page: number;
  pageSize: number;
  situation: 'open' | 'closed' | 'all';
  tab: 'all' | 'mine';
  urgency: TicketUrgency | null;
  type: TicketType | null;
  person: string | null;
  department: string | null;
  robot: string | null;
  q: string;
  sort: 'recent' | 'oldest' | 'urgency';
};

function str(value: unknown, max = 100): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function posInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Lê os filtros da URL da lista. Valor inválido vira o padrão (nunca erro): a tela pode estar em cache de uma versão antiga. */
export function parseListQuery(raw: Record<string, unknown>): ListQuery {
  return {
    page: posInt(raw.page, 1, 1, 1_000_000),
    pageSize: posInt(raw.pageSize, DEFAULT_PAGE_SIZE, 5, MAX_PAGE_SIZE),
    situation: raw.situation === 'closed' || raw.situation === 'all' ? raw.situation : 'open',
    tab: raw.tab === 'mine' ? 'mine' : 'all',
    urgency: isOneOf(TICKET_URGENCIES, raw.urgency) ? raw.urgency : null,
    type: isOneOf(TICKET_TYPES, raw.type) ? raw.type : null,
    person: str(raw.person) || null,
    department: str(raw.department) || null,
    robot: str(raw.robot) || null,
    q: str(raw.q, 80).replace(/^#/, ''),
    sort: raw.sort === 'oldest' || raw.sort === 'urgency' ? raw.sort : 'recent',
  };
}

// ---------- anexos ----------

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const FILE_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

export const ALLOWED_EXTENSIONS_TEXT = 'imagens (png, jpg, gif, webp), planilhas (xlsx, xls, csv), PDF, Word (doc, docx) e texto (txt)';

export type AttachmentCheck =
  | { ok: true; isImage: boolean; mimeType: string; extension: string }
  | { ok: false; reason: string };

/** Confere nome e tamanho de um anexo. O tipo vem da extensão (o `mimetype` do navegador não é confiável). */
export function checkAttachment(fileName: string, size: number): AttachmentCheck {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  const extension = match ? match[1].toLowerCase() : '';
  const image = IMAGE_TYPES[extension];
  const file = FILE_TYPES[extension];
  if (!image && !file) {
    return { ok: false, reason: `"${fileName}": tipo não aceito. Aceitamos ${ALLOWED_EXTENSIONS_TEXT}.` };
  }
  if (size <= 0) {
    return { ok: false, reason: `"${fileName}" está vazio.` };
  }
  if (image && size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `"${fileName}": imagens podem ter até 10 MB.` };
  }
  if (file && size > MAX_FILE_BYTES) {
    return { ok: false, reason: `"${fileName}": arquivos podem ter até 25 MB.` };
  }
  return { ok: true, isImage: !!image, mimeType: (image ?? file)!, extension };
}

// ---------- texto ----------

export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

export function toBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

// ---------- chamados parecidos ----------

export type SimilarityInput = {
  id: string;
  type: string;
  subject: string;
  robotId: string | null;
  dashboardId: string | null;
  hubArea: string | null;
  createdAt: Date;
};

/**
 * Grupos de chamados que provavelmente são o mesmo problema: mesmo tipo e mesmo assunto (o robô, o painel ou a parte do Hub),
 * abertos, e com no máximo `windowDays` dias entre um e o próximo. Cada grupo tem 2 ou mais ids (do mais antigo ao mais novo).
 */
export function suggestMergeGroups(tickets: SimilarityInput[], windowDays = MERGE_WINDOW_DAYS): string[][] {
  const byKey = new Map<string, SimilarityInput[]>();
  for (const ticket of tickets) {
    const target = ticket.robotId ?? ticket.dashboardId ?? (ticket.hubArea ? ticket.hubArea.trim().toLowerCase() : '');
    if (ticket.subject === 'other' || !target) {
      continue; // "outro assunto" ou sem alvo definido: nada para comparar
    }
    const key = `${ticket.type}|${ticket.subject}|${target}`;
    byKey.set(key, [...(byKey.get(key) ?? []), ticket]);
  }

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const groups: string[][] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let current: SimilarityInput[] = [];
    for (const ticket of sorted) {
      const last = current[current.length - 1];
      if (last && ticket.createdAt.getTime() - last.createdAt.getTime() > windowMs) {
        if (current.length >= 2) groups.push(current.map((t) => t.id));
        current = [];
      }
      current.push(ticket);
    }
    if (current.length >= 2) groups.push(current.map((t) => t.id));
  }
  return groups;
}

// ---------- indicadores (só administradores) ----------

export type KpiTicket = {
  id: string;
  status: TicketStatus;
  urgency: TicketUrgency;
  createdAt: Date;
  robotId: string | null;
  robotName: string | null;
  mainTicketId: string | null;
};

export type Kpis = {
  open: number;
  openCritical: number;
  openHigh: number;
  withoutReply: number;
  oldestWithoutReplyAt: string | null;
  avgFirstReplySeconds: number | null;
  firstReplySample: number;
  topRobot: { name: string; count: number } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `firstReplyAt`: id do chamado → data da 1ª resposta de um administrador (mensagem pública, não nota interna).
 * Chamados ligados a outro (`mainTicketId`) não entram nas contas: quem responde é o principal.
 */
export function computeKpis(tickets: KpiTicket[], firstReplyAt: Map<string, Date>, now = new Date()): Kpis {
  const own = tickets.filter((t) => !t.mainTicketId);
  const open = own.filter((t) => OPEN_STATUSES.includes(t.status));
  const withoutReply = open.filter((t) => t.status === 'open' && !firstReplyAt.has(t.id));
  const since = now.getTime() - 30 * DAY_MS;

  const waits = own
    .filter((t) => t.createdAt.getTime() >= since && firstReplyAt.has(t.id))
    .map((t) => Math.max(0, (firstReplyAt.get(t.id)!.getTime() - t.createdAt.getTime()) / 1000));

  const perRobot = new Map<string, { name: string; count: number }>();
  for (const t of tickets) {
    if (t.robotId && t.robotName && t.createdAt.getTime() >= since) {
      const entry = perRobot.get(t.robotId) ?? { name: t.robotName, count: 0 };
      entry.count += 1;
      perRobot.set(t.robotId, entry);
    }
  }
  const top = [...perRobot.values()].sort((a, b) => b.count - a.count)[0] ?? null;

  const oldest = withoutReply.length ? Math.min(...withoutReply.map((t) => t.createdAt.getTime())) : null;
  return {
    open: open.length,
    openCritical: open.filter((t) => t.urgency === 'critical').length,
    openHigh: open.filter((t) => t.urgency === 'high').length,
    withoutReply: withoutReply.length,
    oldestWithoutReplyAt: oldest === null ? null : new Date(oldest).toISOString(),
    avgFirstReplySeconds: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    firstReplySample: waits.length,
    topRobot: top,
  };
}
