// E-mails da verificação por tempo (T0, T1, T2) das execuções AGENDADAS:
//   - aviso de demora (T0 e T1): a execução ainda está rodando além do esperado;
//   - e-mail final do reinício: a 2ª tentativa também não deu certo (reúne tudo num só e-mail).
// Só montagem de texto (sem rede, sem banco); o envio é do MailService.
import { esc, executionLink, formatDateTime, formatDuration, truncate, type BuiltEmail } from './scheduled-execution-alert';

const MAX_REASON_CHARS = 400;

export function formatClock(date: Date): string {
  return date.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

interface Palette { emoji: string; title: string; color: string; soft: string; border: string }
interface Row { label: string; value: string }
interface Button { label: string; url: string }

function renderCard(input: {
  palette: Palette;
  introHtml: string;
  rows: Row[];
  buttons: Button[];
  footnote?: string;
}): string {
  const { palette: p } = input;
  const tr = (r: Row) =>
    `<tr><td style="padding:6px 0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;width:120px;vertical-align:top;">${esc(r.label)}</td><td style="padding:6px 0;font-size:14px;color:#111827;">${esc(r.value)}</td></tr>`;
  const buttons = input.buttons
    .map(
      (b, i) =>
        `<p style="margin:${i === 0 ? 24 : 12}px 0 0;"><a href="${esc(b.url)}" style="display:inline-block;background:${i === 0 ? p.color : '#6b7280'};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px;">${esc(b.label)}</a></p>
         <p style="margin:8px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">${esc(b.url)}</p>`,
    )
    .join('\n');
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${p.color};padding:24px 32px;">
            <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff;opacity:.8;">Automation Hub</p>
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#ffffff;line-height:1.3;">${p.emoji} ${esc(p.title)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${input.introHtml}</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:${p.soft};border:1px solid ${p.border};border-radius:8px;">
              <tr><td style="padding:12px 20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  ${input.rows.map(tr).join('\n                  ')}
                </table>
              </td></tr>
            </table>
            ${input.footnote ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">${esc(input.footnote)}</p>` : ''}
            ${buttons}
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

// ---------------------------------------------------------------------------------------------------------------
// Aviso de demora (T0 = stage 1, T1 = stage 2)
// ---------------------------------------------------------------------------------------------------------------
export interface SlowAlertInput {
  stage: 1 | 2;
  robotName: string;
  scheduleName: string;
  executionId: string;
  startedAt: Date;
  now: Date;
  t1At: Date; // quando sai o próximo aviso (só no stage 1)
  t2At: Date; // quando a execução é cancelada e reiniciada
  baseUrl: string | null;
}

const SLOW_PALETTE: Record<1 | 2, Palette> = {
  1: { emoji: '⏳', title: 'Agendamento demorando', color: '#d97706', soft: '#fffbeb', border: '#fde68a' },
  2: { emoji: '⏳', title: 'Agendamento ainda em execução (2º aviso)', color: '#ea580c', soft: '#fff7ed', border: '#fed7aa' },
};

export function buildScheduleSlowAlert(input: SlowAlertInput): BuiltEmail {
  const palette = SLOW_PALETTE[input.stage];
  const link = executionLink(input.baseUrl, input.executionId);
  const running = formatDuration(input.startedAt, input.now);
  const nextStep =
    input.stage === 1
      ? `Novo aviso às ${formatClock(input.t1At)}. Se ainda estiver rodando às ${formatClock(input.t2At)}, será cancelada e reiniciada automaticamente (uma vez).`
      : `Se ainda estiver rodando às ${formatClock(input.t2At)}, será cancelada e reiniciada automaticamente (uma vez). Vale conferir agora.`;
  const subject = `${palette.emoji} ${input.stage === 1 ? 'Agendamento demorando' : '2º aviso: agendamento ainda em execução'}: ${input.robotName} — ${input.scheduleName}`;
  const verb = input.stage === 1 ? 'está demorando mais que o esperado' : 'continua em execução além do esperado';

  const lines = [
    `A execução agendada "${input.robotName}" ${verb}.`,
    '',
    `Agendamento: ${input.scheduleName}`,
    `Início: ${formatDateTime(input.startedAt)}`,
    `Rodando há: ${running}`,
    `Próximo passo: ${nextStep}`,
  ];
  if (link) lines.push('', `Abrir a execução: ${link}`);
  lines.push('', 'Este é um e-mail automático do Automation Hub.');

  const html = renderCard({
    palette,
    introHtml: `A execução agendada de <strong>${esc(input.robotName)}</strong> <strong style="color:${palette.color};">${esc(verb)}</strong>.`,
    rows: [
      { label: 'Agendamento', value: input.scheduleName },
      { label: 'Início', value: formatDateTime(input.startedAt) },
      { label: 'Rodando há', value: running },
      { label: 'Próximo passo', value: nextStep },
    ],
    buttons: link ? [{ label: 'Abrir a execução no Hub', url: link }] : [],
  });
  return { subject, text: lines.join('\n'), html };
}

// ---------------------------------------------------------------------------------------------------------------
// E-mail final: a execução foi reiniciada e a 2ª tentativa também não deu certo
// ---------------------------------------------------------------------------------------------------------------
export interface AttemptSummary {
  executionId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  // Como terminou, em uma frase (erro do robô, "passou de T2 e foi cancelada", "interrompida pelo reinício do Hub"...)
  outcome: string | null;
}

export interface RestartFailedInput {
  robotName: string;
  scheduleName: string;
  first: AttemptSummary;
  second: AttemptSummary;
  // Agendamentos que dependiam desta execução e foram pulados por causa disso (preenchido pela dependência).
  skipped?: string[];
  baseUrl: string | null;
}

const RESTART_PALETTE: Palette = { emoji: '🚨', title: 'REINICIADA — continua com problema', color: '#991b1b', soft: '#fef2f2', border: '#fecaca' };

function attemptLine(a: AttemptSummary): string {
  const when = `${formatDateTime(a.startedAt)} → ${formatDateTime(a.finishedAt)} (${formatDuration(a.startedAt, a.finishedAt)})`;
  const outcome = a.outcome ? truncate(a.outcome, MAX_REASON_CHARS) : 'sem detalhes registrados';
  return `${when} — ${outcome}`;
}

export function buildRestartFailedAlert(input: RestartFailedInput): BuiltEmail {
  const palette = RESTART_PALETTE;
  const secondLink = executionLink(input.baseUrl, input.second.executionId);
  const firstLink = executionLink(input.baseUrl, input.first.executionId);
  const skipped = (input.skipped ?? []).filter(Boolean);
  const footnote = 'Ela não será tentada de novo automaticamente. O próximo horário do agendamento segue normal.';
  const subject = `🚨 REINICIADA e continua com problema: ${input.robotName} — ${input.scheduleName}`;

  const rows: Row[] = [
    { label: 'Agendamento', value: input.scheduleName },
    { label: '1ª tentativa', value: attemptLine(input.first) },
    { label: '2ª (reinício)', value: attemptLine(input.second) },
  ];
  if (skipped.length > 0) rows.push({ label: 'Não executou', value: skipped.join('; ') });

  const lines = [
    `A execução agendada "${input.robotName}" foi REINICIADA automaticamente e CONTINUA COM PROBLEMA.`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    footnote,
  ];
  if (secondLink) lines.push('', `Abrir o reinício: ${secondLink}`);
  if (firstLink) lines.push(`Abrir a execução original: ${firstLink}`);
  lines.push('', 'Este é um e-mail automático do Automation Hub.');

  const buttons: Button[] = [];
  if (secondLink) buttons.push({ label: 'Abrir o reinício no Hub', url: secondLink });
  if (firstLink) buttons.push({ label: 'Abrir a execução original', url: firstLink });

  const html = renderCard({
    palette,
    introHtml: `A execução agendada de <strong>${esc(input.robotName)}</strong> foi <strong>reiniciada automaticamente</strong> e <strong style="color:${palette.color};">continua com problema</strong>.`,
    rows,
    footnote,
    buttons,
  });
  return { subject, text: lines.join('\n'), html };
}

// Monta o e-mail final a partir do que ExecutionsService.getScheduledExecutionForAlert devolve para uma execução que é
// reinício (attempt 2). Usado tanto pelo runner (a 2ª terminou mal) quanto pelo verificador (a 2ª passou de T2).
export function restartFailedInputFrom(
  data: {
    robotName: string;
    scheduleName: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    errorMessage: string | null;
    first: AttemptSummary | null;
  },
  executionId: string,
  baseUrl: string | null,
  skipped?: string[],
): RestartFailedInput | null {
  if (!data.first) return null;
  return {
    robotName: data.robotName,
    scheduleName: data.scheduleName,
    first: data.first,
    second: { executionId, startedAt: data.startedAt, finishedAt: data.finishedAt, outcome: data.errorMessage },
    skipped,
    baseUrl,
  };
}
