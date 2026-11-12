import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { buildPanelUpdateAlert, type PanelUpdateAlertInput } from './panel-update-alert';
import {
  buildScheduledExecutionAlert,
  scheduleAlertsEnabled,
  type ScheduledExecutionAlertInput,
} from './scheduled-execution-alert';

const FROM    = process.env.MAIL_FROM     ?? 'inovacao01@controller-rnc.com.br';
const PASS    = process.env.MAIL_PASSWORD ?? '';
const BI_TO   = (process.env.MAIL_BI_ALERT_TO ?? 'inovacao02@controller-rnc.com.br,inovacao03@controller-rnc.com.br,inovacao04@controller-rnc.com.br')
  .split(',').map((e) => e.trim()).filter(Boolean);

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  private readonly transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: FROM, pass: PASS },
  });

  async sendBIRefreshFailure(siteName: string): Promise<void> {
    if (!PASS || BI_TO.length === 0) {
      this.logger.warn('Email de alerta de BI não configurado (MAIL_PASSWORD ou MAIL_BI_ALERT_TO ausente).');
      return;
    }

    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    try {
      await this.transporter.sendMail({
        from: `"Automation Hub" <${FROM}>`,
        to: BI_TO.join(', '),
        subject: `⚠️ Falha na atualização do BI: ${siteName}`,
        text: [
          `Ocorreu uma falha na atualização automática do painel "${siteName}".`,
          `Horário: ${now}`,
          'Verifique o status no Hub ou tente atualizar manualmente.',
        ].join('\n'),
        html: buildFailureEmail(siteName, now),
      });
      this.logger.log(`Alerta de falha BI enviado para: ${BI_TO.join(', ')} — ${siteName}`);
    } catch (err) {
      this.logger.error(`Falha ao enviar email de alerta BI (${siteName}): ${(err as Error).message}`);
    }
  }

  // Atualização PROGRAMADA de painel que falhou nas duas tentativas → mesma lista dos alertas de BI. Nunca lança.
  async sendPanelUpdateFailure(input: PanelUpdateAlertInput): Promise<void> {
    if (!scheduleAlertsEnabled()) return;
    if (!PASS || BI_TO.length === 0) {
      this.logger.warn('Email de alerta de painel não configurado (MAIL_PASSWORD ou MAIL_BI_ALERT_TO ausente).');
      return;
    }

    const mail = buildPanelUpdateAlert(input);
    try {
      await this.transporter.sendMail({
        from: `"Automation Hub" <${FROM}>`,
        to: BI_TO.join(', '),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      this.logger.log(`Alerta de atualização de painel enviado para: ${BI_TO.join(', ')} — ${input.panelName}`);
    } catch (err) {
      this.logger.error(`Falha ao enviar email de alerta de painel (${input.panelName}): ${(err as Error).message}`);
    }
  }

  // Execução AGENDADA que falhou, travou ou foi interrompida → mesma lista de destinatários dos alertas de BI.
  // Nunca lança: um problema de e-mail não pode atrapalhar o fluxo de execuções.
  async sendScheduledExecutionAlert(input: ScheduledExecutionAlertInput): Promise<void> {
    if (!scheduleAlertsEnabled()) return;
    if (!PASS || BI_TO.length === 0) {
      this.logger.warn('Email de alerta de agendamento não configurado (MAIL_PASSWORD ou MAIL_BI_ALERT_TO ausente).');
      return;
    }

    const mail = buildScheduledExecutionAlert(input);
    try {
      await this.transporter.sendMail({
        from: `"Automation Hub" <${FROM}>`,
        to: BI_TO.join(', '),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      this.logger.log(`Alerta de agendamento (${input.kind}) enviado para: ${BI_TO.join(', ')} — ${input.robotName} / ${input.scheduleName}`);
    } catch (err) {
      this.logger.error(`Falha ao enviar email de alerta de agendamento (${input.robotName}): ${(err as Error).message}`);
    }
  }
}

function buildFailureEmail(siteName: string, timestamp: string): string {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 16px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Faixa vermelha de alerta -->
          <tr>
            <td style="background:#dc2626;padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <span style="font-size:28px;line-height:1;">⚠️</span>
                  </td>
                  <td style="vertical-align:middle;padding-left:12px;">
                    <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#fca5a5;">Automation Hub</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#ffffff;line-height:1.3;">Falha na atualização do BI</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Corpo -->
          <tr>
            <td style="padding:32px;">

              <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
                A atualização automática do painel abaixo <strong style="color:#dc2626;">não foi concluída</strong>.
                Verifique o status no Hub ou dispare uma nova atualização manualmente.
              </p>

              <!-- Info box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:24px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;">Painel</p>
                    <p style="margin:0;font-size:17px;font-weight:700;color:#111827;">${escHtml(siteName)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 20px 16px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #fecaca;">
                      <tr>
                        <td style="padding-top:12px;">
                          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;">Horário da falha</p>
                          <p style="margin:0;font-size:14px;color:#374151;">${escHtml(timestamp)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                Este é um email automático. Não responda a esta mensagem.
              </p>

            </td>
          </tr>

          <!-- Rodapé -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                Automation Hub · Controller-RNC
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>

</body>
</html>`.trim();
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
