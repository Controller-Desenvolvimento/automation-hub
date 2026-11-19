import {
  TONE_CLASSES,
  URGENCY_LABELS,
  statusLabel,
  statusTone,
  urgencyTone,
  type TicketStatus,
  type TicketUrgency,
} from '../lib/support';
import { cn } from '../lib/utils';

const base = 'inline-flex items-center whitespace-nowrap rounded-lg border px-2.5 py-1 text-[11px] font-medium tracking-[0.02em]';

export function StatusBadge({ status, viewer }: { status: TicketStatus; viewer: 'author' | 'admin' }) {
  return <span className={cn(base, TONE_CLASSES[statusTone(status)])}>{statusLabel(status, viewer)}</span>;
}

export function UrgencyBadge({ urgency }: { urgency: TicketUrgency }) {
  return <span className={cn(base, TONE_CLASSES[urgencyTone(urgency)])}>{URGENCY_LABELS[urgency]}</span>;
}
