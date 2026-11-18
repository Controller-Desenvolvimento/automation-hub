// Tipos e textos do Suporte (chamados). Espelha apps/api/src/support.

export type TicketType = 'problem' | 'suggestion' | 'question';
export type TicketSubject = 'hub' | 'robot' | 'dashboard' | 'other';
export type TicketUrgency = 'critical' | 'high' | 'medium' | 'low';
export type TicketStatus = 'open' | 'review' | 'waiting' | 'resolved' | 'not_issue';
export type MessageKind = 'message' | 'internal' | 'system' | 'system_admin';

export const TYPE_LABELS: Record<TicketType, string> = {
  problem: 'Algo não funciona',
  suggestion: 'Sugestão de melhoria',
  question: 'Dúvida',
};

export const SUBJECT_LABELS: Record<TicketSubject, string> = {
  hub: 'O Hub (alguma tela)',
  robot: 'Um robô',
  dashboard: 'Um painel ou BI',
  other: 'Outro assunto',
};

export const URGENCY_LABELS: Record<TicketUrgency, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

export const URGENCY_HINTS: Record<TicketUrgency, string> = {
  critical: 'Estou parado, não consigo trabalhar',
  high: 'Atrapalha muito ou tem prazo próximo',
  medium: 'Dá para contornar',
  low: 'Pode esperar',
};

export const URGENCIES: TicketUrgency[] = ['critical', 'high', 'medium', 'low'];
export const STATUSES: TicketStatus[] = ['open', 'review', 'waiting', 'resolved', 'not_issue'];
export const OPEN_STATUSES: TicketStatus[] = ['open', 'review', 'waiting'];

export const HUB_AREAS = [
  'Início (Dashboard)',
  'Robôs',
  'Sites / BIs / Painéis',
  'Agendamentos',
  'Histórico / Resultados',
  'Tempo ganho',
  'Login / Perfil',
  'Outra parte',
];

/** "Aguardando resposta" é "Aguardando você" para quem abriu e "Aguardando usuário" para a Inovação. */
export function statusLabel(status: TicketStatus, viewer: 'author' | 'admin') {
  if (status === 'waiting') return viewer === 'author' ? 'Aguardando você' : 'Aguardando usuário';
  return { open: 'Aberto', review: 'Em análise', resolved: 'Resolvido', not_issue: 'Não é problema' }[status];
}

export function statusTone(status: TicketStatus): 'blue' | 'amber' | 'green' | 'gray' | 'violet' {
  return { open: 'blue', review: 'violet', waiting: 'amber', resolved: 'green', not_issue: 'gray' }[status] as
    'blue' | 'amber' | 'green' | 'gray' | 'violet';
}

export function urgencyTone(urgency: TicketUrgency): 'red' | 'orange' | 'amber' | 'gray' {
  return { critical: 'red', high: 'orange', medium: 'amber', low: 'gray' }[urgency] as 'red' | 'orange' | 'amber' | 'gray';
}

export const TONE_CLASSES: Record<string, string> = {
  blue: 'border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/40 dark:bg-sky-950 dark:text-sky-200',
  violet: 'border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/40 dark:bg-violet-950 dark:text-violet-200',
  amber: 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950 dark:text-amber-200',
  green: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950 dark:text-emerald-200',
  gray: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-500/35 dark:bg-slate-800 dark:text-zinc-200',
  red: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-500/40 dark:bg-rose-950 dark:text-rose-200',
  orange: 'border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-950 dark:text-orange-200',
};

export type TicketRow = {
  id: string;
  number: number;
  type: TicketType;
  subject: TicketSubject;
  urgency: TicketUrgency;
  status: TicketStatus;
  title: string;
  hubArea: string | null;
  robot: { id: string; name: string } | null;
  dashboard: { id: string; name: string } | null;
  executionId: string | null;
  authorUnread: boolean;
  authorConfirmed: boolean;
  attachmentsCleanedAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  // só administradores
  author?: { id: string; name: string; departments: string[] };
  assignee?: { id: string; name: string } | null;
  needsAdmin?: boolean;
  mainTicketId?: string | null;
  linkedCount?: number;
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

export type TicketList = {
  tickets: TicketRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Quantos chamados há em cada situação, com os filtros atuais (menos a situação). */
  counts: { open: number; closed: number; all: number };
  // só administradores
  kpis?: Kpis;
  suggestions?: TicketRow[][];
  facets?: { people: Array<{ id: string; name: string }>; departments: string[]; robots: Array<{ id: string; name: string }> };
};

export type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  /** O arquivo foi apagado pela retenção (90 dias depois de o chamado ser encerrado); nome e tamanho continuam. */
  removed: boolean;
  downloadUrl: string | null;
};

export type TicketMessage = {
  id: string;
  kind: MessageKind;
  body: string;
  createdAt: string;
  author: { id: string; name: string; isStaff: boolean } | null;
  fromTicket: { id: string; number: number; authorName: string } | null;
  attachments: Attachment[];
};

export type ExecutionContext = {
  executionId: string;
  robotName: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  parameters: Record<string, unknown>;
  hiddenParameters: string[];
  logTail: Array<{ level: string; message: string; timestamp: string }>;
};

export type TicketDetail = TicketRow & {
  context: ExecutionContext | null;
  main: { id: string; number: number; title: string } | null;
  similar: TicketRow[];
  linked?: Array<{ id: string; number: number; title: string; status: TicketStatus; author: { id: string; name: string; departments: string[] } }>;
  messages: TicketMessage[];
};

export type SupportOptions = {
  robots: Array<{ id: string; name: string }>;
  dashboards: Array<{ id: string; name: string }>;
  admins: Array<{ id: string; name: string }>;
};

export const ACCEPT_ATTACHMENTS = '.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.csv,.pdf,.doc,.docx,.txt';
export const MAX_ATTACHMENTS = 5;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const FILE_EXT = /\.(xlsx|xls|csv|pdf|docx?|txt)$/i;

export function isImageName(name: string) {
  return IMAGE_EXT.test(name);
}

/** Mesma conferência do servidor, para avisar antes de enviar. Devolve o motivo ou null se o arquivo serve. */
export function attachmentProblem(file: { name: string; size: number }): string | null {
  const image = IMAGE_EXT.test(file.name);
  if (!image && !FILE_EXT.test(file.name)) {
    return `"${file.name}": tipo não aceito. Aceitamos imagens, planilhas (xlsx, csv), PDF, Word e texto.`;
  }
  if (file.size <= 0) return `"${file.name}" está vazio.`;
  if (image && file.size > 10 * 1024 * 1024) return `"${file.name}": imagens podem ter até 10 MB.`;
  if (!image && file.size > 25 * 1024 * 1024) return `"${file.name}": arquivos podem ter até 25 MB.`;
  return null;
}

export function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatWait(seconds: number | null) {
  if (seconds === null) return { value: '—', unit: '' };
  if (seconds < 3600) return { value: String(Math.max(1, Math.round(seconds / 60))), unit: 'min' };
  if (seconds < 86400) return { value: (seconds / 3600).toFixed(1).replace('.', ','), unit: 'h' };
  return { value: (seconds / 86400).toFixed(1).replace('.', ','), unit: 'd' };
}

export function subjectText(t: Pick<TicketRow, 'subject' | 'robot' | 'dashboard' | 'hubArea'>) {
  if (t.subject === 'robot') return t.robot ? `Robô: ${t.robot.name}` : 'Um robô';
  if (t.subject === 'dashboard') return t.dashboard ? `Painel: ${t.dashboard.name}` : 'Um painel ou BI';
  if (t.subject === 'hub') return t.hubArea ? `Hub: ${t.hubArea}` : 'O Hub';
  return 'Outro assunto';
}
