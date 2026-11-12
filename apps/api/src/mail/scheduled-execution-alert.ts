// E-mail para a Inovação quando uma execução AGENDADA falha, trava ou é interrompida.
// Só montagem de texto (sem rede, sem banco) para poder ser testada isoladamente; o envio é do MailService.

export type ScheduledExecutionAlertKind = 'error' | 'stalled' | 'interrupted';

export interface ScheduledExecutionAlertInput {
  kind: ScheduledExecutionAlertKind;
  robotName: string;
  scheduleName: string;
  executionId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  // Endereço público do Hub (ver resolveHubBaseUrl). Sem ele o e-mail sai sem o link.
  baseUrl: string | null;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

const MAX_REASON_CHARS = 600;

const KIND_INFO: Record<
  ScheduledExecutionAlertKind,
  { emoji: string; title: string; verb: string; color: string; soft: string; border: string }
> = {
  error: { emoji: '⚠️', title: 'Agendamento falhou', verb: 'terminou com erro', color: '#dc2626', soft: '#fef2f2', border: '#fecaca' },
  stalled: { emoji: '⏱️', title: 'Agendamento travou', verb: 'travou e foi encerrada', color: '#d97706', soft: '#fffbeb', border: '#fde68a' },
  interrupted: { emoji: '🔌', title: 'Agendamento interrompido', verb: 'foi interrompida', color: '#7c3aed', soft: '#f5f3ff', border: '#ddd6fe' },
};

// Endereço local (a pessoa que recebe o e-mail não consegue abrir): localhost, 127.x, ::1, 0.0.0.0.
export function isLocalAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
  } catch {
    return true;
  }
}

// Endereço pelo qual as pessoas abrem o Hub. HUB_PUBLIC_URL tem prioridade; senão usa o primeiro
// ALLOWED_ORIGIN que não seja local (no servidor é o endereço que os gestores usam). Só aceita http(s).
// Endereço local nunca vai para o e-mail: sem nenhum endereço válido, o e-mail sai sem o link.
export function resolveHubBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const candidates = [env.HUB_PUBLIC_URL, ...(env.ALLOWED_ORIGIN ?? '').split(',')];
  for (const raw of candidates) {
    const value = (raw ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\/[^\s/]+/i.test(value) && !isLocalAddress(value)) return value;
  }
  return null;
}

// Liga/desliga os e-mails de agendamento sem reiniciar o código: SCHEDULE_ALERT_EMAILS=false no .env.
export function scheduleAlertsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.SCHEDULE_ALERT_EMAILS ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'nao', 'não', 'off'].includes(raw);
}

export function formatDateTime(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function formatDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return '—';
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function executionLink(baseUrl: string | null, executionId: string): string | null {
  return baseUrl && !isLocalAddress(baseUrl) ? `${baseUrl}/executions/${encodeURIComponent(executionId)}` : null;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function buildScheduledExecutionAlert(input: ScheduledExecutionAlertInput): BuiltEmail {
  const info = KIND_INFO[input.kind];
  const link = executionLink(input.baseUrl, input.executionId);
  const reason = input.errorMessage ? truncate(input.errorMessage, MAX_REASON_CHARS) : 'Sem detalhes registrados.';
  const started = formatDateTime(input.startedAt);
  const finished = formatDateTime(input.finishedAt);
  const duration = formatDuration(input.startedAt, input.finishedAt);

  const subject = `${info.emoji} ${info.title}: ${input.robotName} — ${input.scheduleName}`;

  const lines = [
    `A execução agendada "${input.robotName}" ${info.verb}.`,
    '',
    `Agendamento: ${input.scheduleName}`,
    `Início: ${started}`,
    `Fim: ${finished}`,
    `Duração: ${duration}`,
    `Motivo: ${reason}`,
  ];
  if (link) lines.push('', `Abrir a execução: ${link}`);
  lines.push('', 'Este é um e-mail automático do Automation Hub.');
  const text = lines.join('\n');

  return { subject, text, html: buildHtml(input, info, { started, finished, duration, reason, link }) };
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:6px 0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;width:110px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;font-size:14px;color:#111827;">${esc(value)}</td></tr>`;
}

function buildHtml(
  input: ScheduledExecutionAlertInput,
  info: (typeof KIND_INFO)[ScheduledExecutionAlertKind],
  d: { started: string; finished: string; duration: string; reason: string; link: string | null },
): string {
  const button = d.link
    ? `<p style="margin:24px 0 0;"><a href="${esc(d.link)}" style="display:inline-block;background:${info.color};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">Abrir a execução no Hub</a></p>
       <p style="margin:12px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${esc(d.link)}</p>`
    : '';
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${info.color};padding:24px 32px;">
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;opacity:.8;">Automation Hub</p>
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#ffffff;line-height:1.3;">${info.emoji} ${esc(info.title)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A execução agendada de <strong>${esc(input.robotName)}</strong> <strong style="color:${info.color};">${esc(info.verb)}</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${info.soft};border:1px solid ${info.border};border-radius:8px;">
              <tr><td style="padding:12px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  ${row('Agendamento', input.scheduleName)}
                  ${row('Início', d.started)}
                  ${row('Fim', d.finished)}
                  ${row('Duração', d.duration)}
                  ${row('Motivo', d.reason)}
                </table>
              </td></tr>
            </table>
            ${button}
            <p style="margin:24px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">Este é um e-mail automático. Não responda a esta mensagem.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Automation Hub · Controller-RNC</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
