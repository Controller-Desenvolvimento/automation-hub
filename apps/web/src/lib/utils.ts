import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type {
  AutomationRequestCadence,
  AutomationRequestStatus,
  AutomationRequestUrgency,
  SiteCategory,
  SiteStatus,
} from './types';

type StatusVariant =
  | 'default'
  | 'success'
  | 'running'
  | 'queued'
  | 'error'
  | 'canceled'
  | 'muted'
  | 'warning'
  | 'danger';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value?: string | null) {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString('pt-BR');
}

export function statusLabel(status: string) {
  return {
    success: 'Concluído',
    running: 'Em andamento',
    queued: 'Na fila',
    error: 'Erro',
    canceled: 'Cancelado',
  }[status] ?? 'Indisponível';
}

export function statusVariant(status: string): StatusVariant {
  const variants: Record<string, StatusVariant> = {
    success: 'success',
    running: 'running',
    queued: 'queued',
    error: 'error',
    canceled: 'canceled',
  };

  return variants[status] ?? 'muted';
}

export function siteStatusLabel(status: SiteStatus) {
  return {
    online: 'Online',
    maintenance: 'Manutenção',
    down: 'Fora do ar',
  }[status];
}

export function siteStatusVariant(status: SiteStatus): StatusVariant {
  const variants: Record<SiteStatus, StatusVariant> = {
    online: 'success',
    maintenance: 'warning',
    down: 'danger',
  };

  return variants[status];
}

export function siteCategoryLabel(category: SiteCategory) {
  return { sistema: 'Sistema', bi: 'BI' }[category];
}

export function initialsFor(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

const DEPT_LABEL_FALLBACK: Record<string, string> = {
  pessoal: 'Pessoal',
  fiscal: 'Fiscal',
  contabil: 'Contábil',
  tecnologia: 'Tecnologia',
  inovacao: 'Inovação',
  legalizacao: 'Legalização',
  certificacao: 'Certificação',
  auditoria: 'Auditoria',
  rh: 'RH',
};

export function departmentLabel(value: string, departments?: Array<{ slug: string; name: string }>) {
  if (departments) {
    const found = departments.find((d) => d.slug === value);
    if (found) return found.name;
  }
  return DEPT_LABEL_FALLBACK[value] ?? value;
}

export function userFileName(value?: string | null) {
  if (!value) return 'arquivo';
  const clean = value.trim();
  const withoutPrefixes = clean.replace(/^(?:\d{13}-[a-z0-9]{6}-)+/i, '');
  return withoutPrefixes || clean;
}

export function timeAgo(value?: string | null) {
  if (!value) return 'Nunca verificado';

  const diffMinutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (diffMinutes < 1) return 'Agora mesmo';
  if (diffMinutes < 60) return `há ${diffMinutes} min`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `há ${diffHours}h`;

  const diffDays = Math.round(diffHours / 24);
  return `há ${diffDays}d`;
}

export function formatSecondsToHuman(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}min`;
  }

  if (minutes === 0 && seconds > 0) {
    return `${seconds}s`;
  }

  return `${minutes}min`;
}

export function automationRequestStatusLabel(status: AutomationRequestStatus) {
  return {
    pending: 'Pendente',
    review: 'Em análise',
    approved: 'Aprovado',
    in_progress: 'Em desenvolvimento',
    done: 'Concluído',
    rejected: 'Recusado',
  }[status];
}

export function automationRequestStatusVariant(status: AutomationRequestStatus): StatusVariant {
  return {
    pending: 'warning',
    review: 'queued',
    approved: 'success',
    in_progress: 'running',
    done: 'success',
    rejected: 'danger',
  }[status] as StatusVariant;
}

export function automationRequestUrgencyLabel(urgency: AutomationRequestUrgency) {
  return {
    low: 'Baixa',
    normal: 'Normal',
    high: 'Alta',
    urgent: 'Urgente',
  }[urgency];
}

export function automationRequestCadenceLabel(cadence: AutomationRequestCadence) {
  return {
    once: 'Avulsa',
    daily: 'Diária',
    weekly: 'Semanal',
    monthly: 'Mensal',
  }[cadence];
}

/** Data completa e plausível (AAAA-MM-DD, ano de 2000 a 2100). Enquanto a pessoa digita, o campo de data passa por valores
 * pela metade (ano 0002, 0020, 0202...) ou vazios: nenhum deles pode virar filtro. */
export function isCompleteDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(year, Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === year && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]);
}
