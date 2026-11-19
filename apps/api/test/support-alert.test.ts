import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupportAlert, claimReplyAlert, supportAlertsEnabled, ticketLink, type SupportAlertInput } from '../src/mail/support-alert';

const base: SupportAlertInput = {
  kind: 'new',
  ticketId: 'abc123',
  number: 1049,
  title: 'Robô Gestta parou na linha 5',
  authorName: 'Ana Souza',
  authorDepartment: 'Fiscal',
  typeLabel: 'Algo não funciona',
  subjectLabel: 'Robô: Gestta — Baixar planilhas',
  urgencyLabel: 'Alta',
  critical: false,
  assigneeName: null,
  linkedToNumber: null,
  baseUrl: 'https://hubcontroller.com.br',
};

test('chamado novo: assunto, resumo e link; sem o texto da mensagem', () => {
  const mail = buildSupportAlert(base);
  assert.equal(mail.subject, '🆘 Novo chamado #1049: Robô Gestta parou na linha 5');
  assert.match(mail.text, /Ana Souza \(Fiscal\) abriu um chamado #1049\./);
  assert.match(mail.text, /Assunto: Robô: Gestta — Baixar planilhas/);
  assert.match(mail.text, /Urgência: Alta/);
  assert.match(mail.text, /Abrir o chamado: https:\/\/hubcontroller\.com\.br\/support\/abc123/);
  assert.match(mail.text, /não vão por e-mail/);
  assert.match(mail.html, /href="https:\/\/hubcontroller\.com\.br\/support\/abc123"/);
  assert.equal(mail.attachments, undefined, 'nunca leva anexos');
});

test('crítico aparece no assunto e muda a cor', () => {
  const mail = buildSupportAlert({ ...base, critical: true, urgencyLabel: 'Crítica' });
  assert.match(mail.subject, /\(CRÍTICO\)/);
  assert.match(mail.html, /#dc2626/);
  assert.doesNotMatch(buildSupportAlert(base).subject, /CRÍTICO/);
});

test('resposta e reaberto: assunto próprio com o nome de quem escreveu', () => {
  assert.equal(buildSupportAlert({ ...base, kind: 'reply' }).subject, '💬 Chamado #1049: Ana Souza respondeu');
  assert.equal(buildSupportAlert({ ...base, kind: 'reopen' }).subject, '🔁 Chamado #1049: Ana Souza reabriu');
  assert.match(buildSupportAlert({ ...base, kind: 'reopen' }).text, /reabriu o chamado \(ainda acontece\)/);
});

test('responsável e chamado ligado aparecem quando existem', () => {
  const mail = buildSupportAlert({ ...base, kind: 'reply', assigneeName: 'Davi Baptista', linkedToNumber: 1040 });
  assert.match(mail.text, /Responsável: Davi Baptista/);
  assert.match(mail.text, /Ligado a: #1040 \(atenda pelo principal\)/);
  assert.doesNotMatch(buildSupportAlert(base).text, /Responsável|Ligado a/);
});

test('texto digitado pela pessoa não injeta HTML', () => {
  const mail = buildSupportAlert({ ...base, title: '<img src=x onerror=alert(1)>', authorName: '"><script>x</script>' });
  assert.doesNotMatch(mail.html, /<img src=x/);
  assert.doesNotMatch(mail.html, /<script>x<\/script>/);
  assert.match(mail.html, /&lt;img src=x/);
});

test('título muito longo é cortado', () => {
  const mail = buildSupportAlert({ ...base, title: 'x'.repeat(500) });
  assert.ok(mail.subject.length < 200);
  assert.match(mail.subject, /…$/);
});

test('sem endereço público (ou só local), o e-mail sai sem link', () => {
  for (const baseUrl of [null, 'http://localhost:3000', 'http://127.0.0.1:3000']) {
    const mail = buildSupportAlert({ ...base, baseUrl });
    assert.doesNotMatch(mail.text, /Abrir o chamado:/);
    assert.doesNotMatch(mail.html, /<a href=/);
  }
  assert.equal(ticketLink('https://h.com', 'a b'), 'https://h.com/support/a%20b');
});

test('SUPPORT_ALERT_EMAILS=false desliga; o padrão é ligado', () => {
  assert.equal(supportAlertsEnabled({}), true);
  assert.equal(supportAlertsEnabled({ SUPPORT_ALERT_EMAILS: 'true' }), true);
  for (const off of ['false', 'FALSE', '0', 'no', 'não', 'off']) assert.equal(supportAlertsEnabled({ SUPPORT_ALERT_EMAILS: off }), false, off);
});

test('respostas seguidas no mesmo chamado: um e-mail por janela, por chamado', () => {
  const sent = new Map<string, number>();
  const W = 10 * 60_000;
  assert.equal(claimReplyAlert(sent, 'a', 0, W), true);
  assert.equal(claimReplyAlert(sent, 'a', 5 * 60_000, W), false, 'dentro da janela');
  assert.equal(claimReplyAlert(sent, 'b', 5 * 60_000, W), true, 'outro chamado não é afetado');
  assert.equal(claimReplyAlert(sent, 'a', W, W), true, 'passada a janela avisa de novo');
  assert.equal(claimReplyAlert(sent, 'a', W + 1000, W), false);
});

test('o mapa de controle não cresce para sempre', () => {
  const sent = new Map<string, number>();
  for (let i = 0; i < 600; i++) claimReplyAlert(sent, `t${i}`, 0, 1000);
  claimReplyAlert(sent, 'novo', 5000, 1000); // tudo antigo passou da janela
  assert.ok(sent.size <= 2, String(sent.size));
});
