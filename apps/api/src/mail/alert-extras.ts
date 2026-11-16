// Partes extras dos e-mails de execução AGENDADA: avisos do robô (AH_ALERT) e print da tela no momento da falha.
// Só montagem de texto (sem rede, sem banco); o envio é do MailService.

export interface AlertScreenshot {
  filename: string;
  content: Buffer;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  cid: string;
  contentType: string;
}

export const MAX_ALERT_WARNINGS = 10;
export const MAX_WARNING_CHARS = 300;
export const MAX_SCREENSHOTS = 2;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
// Imagem de erro que o robô deixa na pasta de saída: erro_<carimbo>.png / .jpg
export const SCREENSHOT_NAME_PATTERN = /^erro[^/\\]*\.(png|jpe?g)$/i;

// Limpa a lista de avisos: tira vazios e repetidos, corta o tamanho de cada um e limita a quantidade.
export function cleanWarnings(raw: Array<string | null | undefined> | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw ?? []) {
    const text = (item ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const clipped = text.length > MAX_WARNING_CHARS ? `${text.slice(0, MAX_WARNING_CHARS - 1)}…` : text;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= MAX_ALERT_WARNINGS) break;
  }
  return out;
}

function contentTypeFor(filename: string): string {
  return /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
}

// Anexos (com cid para aparecer dentro do e-mail). Já limitados em quantidade e tamanho.
export function screenshotAttachments(screenshots: AlertScreenshot[] | undefined): MailAttachment[] {
  return (screenshots ?? [])
    .filter((s) => s.content.length > 0 && s.content.length <= MAX_SCREENSHOT_BYTES)
    .slice(0, MAX_SCREENSHOTS)
    .map((s, i) => ({
      filename: s.filename.replace(/[^\w.\- ]+/g, '_'),
      content: s.content,
      cid: `print-${i + 1}@automation-hub`,
      contentType: contentTypeFor(s.filename),
    }));
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ExtrasInput {
  warnings?: string[];
  screenshots?: AlertScreenshot[];
}

export interface BuiltExtras {
  text: string[];            // linhas para o corpo em texto (vazio = nada a acrescentar)
  html: string;              // bloco HTML ('' = nada a acrescentar)
  attachments: MailAttachment[];
}

export function buildExtras(input: ExtrasInput): BuiltExtras {
  const warnings = cleanWarnings(input.warnings);
  const attachments = screenshotAttachments(input.screenshots);

  const text: string[] = [];
  let html = '';

  if (warnings.length > 0) {
    text.push('', 'Avisos durante a execução:', ...warnings.map((w) => `- ${w}`));
    html += `<p style="margin:20px 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;">Avisos durante a execução</p>
      <ul style="margin:0;padding-left:20px;font-size:14px;color:#374151;line-height:1.6;">${warnings.map((w) => `<li>${escape(w)}</li>`).join('')}</ul>`;
  }

  if (attachments.length > 0) {
    text.push('', `Print da tela no momento da falha: ${attachments.length === 1 ? 'anexado' : 'anexados'} a este e-mail (dados borrados por privacidade).`);
    html += `<p style="margin:20px 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;">Tela no momento da falha</p>
      ${attachments.map((a) => `<img src="cid:${a.cid}" alt="Print da tela no momento da falha" style="display:block;max-width:100%;height:auto;border:1px solid #e5e7eb;border-radius:6px;margin:0 0 10px;">`).join('')}
      <p style="margin:0;font-size:12px;color:#6b7280;">Dados borrados por privacidade; ficam visíveis só botões, menus e mensagens.</p>`;
  }

  return { text, html, attachments };
}

// ---------------------------------------------------------------------------------------------------------------
// E-mail só de AVISO (a execução terminou com sucesso, mas o robô registrou avisos)
// ---------------------------------------------------------------------------------------------------------------
export interface ScheduledWarningInput {
  robotName: string;
  scheduleName: string;
  executionId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  warnings: string[];
  baseUrl: string | null;
}
