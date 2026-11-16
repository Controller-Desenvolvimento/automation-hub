import assert from 'node:assert/strict';
import test, { before } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */
// MAIL_PASSWORD e MAIL_BI_ALERT_TO são lidos quando o módulo é carregado: define antes do import.
let MailService: any;
before(async () => {
  process.env.MAIL_PASSWORD = 'senha-de-teste';
  process.env.MAIL_BI_ALERT_TO = 'a@exemplo.invalid,b@exemplo.invalid';
  MailService = (await import('../src/mail/mail.service')).MailService;
});

function montar() {
  const enviados: any[] = [];
  const svc = new MailService();
  svc.transporter = { sendMail: async (m: unknown) => { enviados.push(m); } };
  return { svc, enviados };
}

const base = {
  kind: 'error', robotName: 'Gestta', scheduleName: 'Gestta 06:30', executionId: 'cm1',
  startedAt: new Date('2026-11-16T09:30:00Z'), finishedAt: new Date('2026-11-16T09:40:00Z'),
  errorMessage: 'Nao achei o botao', baseUrl: 'https://hub.exemplo.com',
};

test('e-mail de erro com print: o anexo chega ao transporte com cid, tipo e conteúdo', async () => {
  const { svc, enviados } = montar();
  await svc.sendScheduledExecutionAlert({ ...base, warnings: ['aviso'], screenshots: [{ filename: 'erro_1.png', content: Buffer.from('PNG') }] });
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'a@exemplo.invalid, b@exemplo.invalid');
  assert.equal(enviados[0].attachments.length, 1);
  assert.equal(enviados[0].attachments[0].filename, 'erro_1.png');
  assert.equal(enviados[0].attachments[0].contentType, 'image/png');
  assert.equal(enviados[0].attachments[0].cid, 'print-1@automation-hub');
  assert.equal(enviados[0].attachments[0].content.toString(), 'PNG');
  assert.match(enviados[0].html, /cid:print-1@automation-hub/);
});

test('e-mail de erro sem print: não leva a chave de anexos', async () => {
  const { svc, enviados } = montar();
  await svc.sendScheduledExecutionAlert(base);
  assert.equal(enviados[0].attachments, undefined);
});

test('e-mail de AVISO: sai com o assunto "Atenção" e sem anexos', async () => {
  const { svc, enviados } = montar();
  await svc.sendScheduledWarningAlert({ robotName: 'Gestta', scheduleName: 'Gestta 06:30', executionId: 'cm1', startedAt: null, finishedAt: null, warnings: ['x'], baseUrl: null });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].subject, /Atenção: Gestta — Gestta 06:30/);
  assert.equal(enviados[0].attachments, undefined);
});

test('SCHEDULE_ALERT_EMAILS=false desliga também o e-mail de aviso e o de erro com print', async () => {
  const antes = process.env.SCHEDULE_ALERT_EMAILS;
  process.env.SCHEDULE_ALERT_EMAILS = 'false';
  try {
    const { svc, enviados } = montar();
    await svc.sendScheduledWarningAlert({ robotName: 'G', scheduleName: 'S', executionId: 'e', startedAt: null, finishedAt: null, warnings: ['x'], baseUrl: null });
    await svc.sendScheduledExecutionAlert({ ...base, screenshots: [{ filename: 'erro.png', content: Buffer.from('x') }] });
    assert.equal(enviados.length, 0);
  } finally {
    if (antes === undefined) delete process.env.SCHEDULE_ALERT_EMAILS; else process.env.SCHEDULE_ALERT_EMAILS = antes;
  }
});

test('falha do SMTP no e-mail de aviso não lança (não pode atrapalhar a execução)', async () => {
  const svc = new MailService();
  svc.transporter = { sendMail: async () => { throw new Error('SMTP fora do ar'); } };
  await svc.sendScheduledWarningAlert({ robotName: 'G', scheduleName: 'S', executionId: 'e', startedAt: null, finishedAt: null, warnings: ['x'], baseUrl: null });
});
