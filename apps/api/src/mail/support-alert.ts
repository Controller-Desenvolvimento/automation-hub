// E-mail para a Inovação sobre chamados do Suporte que esperam por ela. Só montagem de texto (sem rede, sem banco);
// o envio é do MailService. O e-mail leva só o RESUMO e o link: o texto da mensagem e os anexos ficam no Hub
// (podem ter dados de clientes ou de RH, e um e-mail fica guardado fora do Hub).
import { esc, isLocalAddress, truncate, type BuiltEmail } from './scheduled-execution-alert';

export type SupportAlertKind = 'new' | 'reply' | 'reopen';

export interface SupportAlertInput {
  kind: SupportAlertKind;
  ticketId: string;
  number: number;
  title: string;
  authorName: string;
  authorDepartment: string | null;
  typeLabel: string;
  subjectLabel: string;
  urgencyLabel: string;
  critical: boolean;
  assigneeName: string | null;
  /** O chamado está ligado a outro (o atendimento é feito no principal). */
  linkedToNumber: number | null;
  baseUrl: string | null;
}

const KIND_INFO: Record<SupportAlertKind, { emoji: string; title: string; verb: string }> = {
  new: { emoji: '🆘', title: 'Novo chamado no Suporte', verb: 'abriu um chamado' },
  reply: { emoji: '💬', title: 'Resposta em chamado do Suporte', verb: 'respondeu o chamado' },
  reopen: { emoji: '🔁', title: 'Chamado reaberto no Suporte', verb: 'reabriu o chamado (ainda acontece)' },
};

const COLOR = '#0284c7';
const COLOR_CRITICAL = '#dc2626';
const SOFT = '#f0f9ff';
const BORDER = '#bae6fd';
const MAX_TITLE_CHARS = 140;

export function ticketLink(baseUrl: string | null, ticketId: string): string | null {
  return baseUrl && !isLocalAddress(baseUrl) ? `${baseUrl}/support/${encodeURIComponent(ticketId)}` : null;
}

/** Liga/desliga os e-mails do Suporte sem mexer no código: SUPPORT_ALERT_EMAILS=false no .env. */
export function supportAlertsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.SUPPORT_ALERT_EMAILS ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'nao', 'não', 'off'].includes(raw);
}

/**
 * Várias respostas seguidas na mesma conversa viram UM e-mail: depois de avisar, só avisa de novo daquele chamado
 * passados `windowMs`. Chamado novo e reaberto avisam sempre. Devolve true se deve enviar (e registra o envio).
 */
export function claimReplyAlert(sent: Map<string, number>, ticketId: string, now: number, windowMs: number): boolean {
  const last = sent.get(ticketId);
  if (last !== undefined && now - last < windowMs) return false;
  sent.set(ticketId, now);
  // Não deixa o mapa crescer para sempre: esquece o que já passou da janela.
  if (sent.size > 500) {
    for (const [id, at] of sent) if (now - at >= windowMs) sent.delete(id);
  }
  return true;
}

export function buildSupportAlert(input: SupportAlertInput): BuiltEmail {
  const info = KIND_INFO[input.kind];
  const color = input.critical ? COLOR_CRITICAL : COLOR;
  const link = ticketLink(input.baseUrl, input.ticketId);
  const title = truncate(input.title, MAX_TITLE_CHARS);
  const who = input.authorDepartment ? `${input.authorName} (${input.authorDepartment})` : input.authorName;

  const subject =
    input.kind === 'new'
      ? `${info.emoji} Novo chamado #${input.number}${input.critical ? ' (CRÍTICO)' : ''}: ${title}`
      : `${info.emoji} Chamado #${input.number}: ${input.authorName} ${input.kind === 'reply' ? 'respondeu' : 'reabriu'}`;

  const rows: Array<[string, string]> = [
    ['Chamado', `#${input.number} — ${title}`],
    ['De', who],
    ['Tipo', input.typeLabel],
    ['Assunto', input.subjectLabel],
    ['Urgência', input.urgencyLabel],
  ];
  if (input.assigneeName) rows.push(['Responsável', input.assigneeName]);
  if (input.linkedToNumber) rows.push(['Ligado a', `#${input.linkedToNumber} (atenda pelo principal)`]);

  const note = 'O texto da mensagem e os anexos não vão por e-mail: abra o chamado no Hub para ler e responder.';
  const intro = `${who} ${info.verb} #${input.number}.`;

  const lines = [intro, '', ...rows.map(([label, value]) => `${label}: ${value}`), '', note];
  if (link) lines.push('', `Abrir o chamado: ${link}`);
  lines.push('', 'Este é um e-mail automático do Automation Hub.');

  const tr = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;width:110px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;font-size:14px;color:#111827;">${esc(value)}</td></tr>`;
  const button = link
    ? `<p style="margin:24px 0 0;"><a href="${esc(link)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">Abrir o chamado no Hub</a></p>
       <p style="margin:12px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${esc(link)}</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${color};padding:24px 32px;">
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;opacity:.8;">Automation Hub · Suporte</p>
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#ffffff;line-height:1.3;">${info.emoji} ${esc(info.title)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              <strong>${esc(who)}</strong> ${esc(info.verb)} <strong>#${input.number}</strong>.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border:1px solid ${BORDER};border-radius:8px;">
              <tr><td style="padding:12px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  ${rows.map(([label, value]) => tr(label, value)).join('\n                  ')}
                </table>
              </td></tr>
            </table>
            <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">${esc(note)}</p>
            ${button}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">Este é um e-mail automático do Automation Hub.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text: lines.join('\n'), html };
}
