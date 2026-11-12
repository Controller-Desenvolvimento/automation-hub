// E-mail para a Inovação quando a atualização PROGRAMADA de um painel falha nas duas tentativas.
// Só montagem de texto (sem rede, sem banco); o envio é do MailService.
import { esc, formatDateTime, isLocalAddress, truncate, type BuiltEmail } from './scheduled-execution-alert';

export interface PanelUpdateAttempt {
  at: Date | null;
  error: string | null;
}

export interface PanelUpdateAlertInput {
  panelName: string;
  slug: string;
  // 1ª e 2ª tentativa, nessa ordem
  attempts: PanelUpdateAttempt[];
  baseUrl: string | null;
}

const COLOR = '#dc2626';
const SOFT = '#fef2f2';
const BORDER = '#fecaca';
const MAX_REASON_CHARS = 400;

// Tela de Painéis do Hub, já com este painel aberto (mesma rota que o botão "Abrir" usa).
export function panelLink(baseUrl: string | null, slug: string): string | null {
  return baseUrl && !isLocalAddress(baseUrl) ? `${baseUrl}/sites?tab=paineis&painel=${encodeURIComponent(slug)}` : null;
}

export function buildPanelUpdateAlert(input: PanelUpdateAlertInput): BuiltEmail {
  const link = panelLink(input.baseUrl, input.slug);
  const rows = input.attempts.map((a, i) => ({
    label: `${i + 1}ª tentativa`,
    value: `${formatDateTime(a.at)} — ${a.error ? truncate(a.error, MAX_REASON_CHARS) : 'sem detalhes registrados'}`,
  }));
  const subject = `⚠️ Painel não atualizou: ${input.panelName}`;
  const n = input.attempts.length;
  const textTries = n === 1 ? 'na tentativa' : `em ${n} tentativas`;
  const htmlTries = n === 1 ? 'na tentativa' : `nas ${n} tentativas`;
  const intro = `A atualização programada do painel "${input.panelName}" falhou ${textTries} e precisa ser verificada.`;
  const note = 'O painel continua no ar, mas com os dados da última atualização bem-sucedida.';

  const lines = [intro, '', ...rows.map((r) => `${r.label}: ${r.value}`), '', note];
  if (link) lines.push('', `Abrir os painéis: ${link}`);
  lines.push('', 'Este é um e-mail automático do Automation Hub.');

  const button = link
    ? `<p style="margin:24px 0 0;"><a href="${esc(link)}" style="display:inline-block;background:${COLOR};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">Abrir os painéis no Hub</a></p>
       <p style="margin:12px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${esc(link)}</p>`
    : '';
  const tr = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;width:110px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;font-size:14px;color:#111827;">${esc(value)}</td></tr>`;

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${COLOR};padding:24px 32px;">
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;opacity:.8;">Automation Hub</p>
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#ffffff;line-height:1.3;">⚠️ Painel não atualizou</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A atualização programada do painel <strong>${esc(input.panelName)}</strong> <strong style="color:${COLOR};">falhou ${htmlTries}</strong> e precisa ser verificada.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border:1px solid ${BORDER};border-radius:8px;">
              <tr><td style="padding:12px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  ${tr('Painel', input.panelName)}
                  ${rows.map((r) => tr(r.label, r.value)).join('\n                  ')}
                </table>
              </td></tr>
            </table>
            <p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">${esc(note)}</p>
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

  return { subject, text: lines.join('\n'), html };
}
