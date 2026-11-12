import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildScheduledExecutionAlert,
  executionLink,
  formatDuration,
  isLocalAddress,
  resolveHubBaseUrl,
  scheduleAlertsEnabled,
  type ScheduledExecutionAlertInput,
} from '../src/mail/scheduled-execution-alert';

const base: ScheduledExecutionAlertInput = {
  kind: 'error',
  robotName: 'Atualização BI - Gestta',
  scheduleName: 'Gestta 06:30',
  executionId: 'cmabc123',
  startedAt: new Date('2026-11-12T09:30:00Z'),
  finishedAt: new Date('2026-11-12T09:47:30Z'),
  errorMessage: 'Falha ao baixar o relatório.',
  baseUrl: 'https://hubcontroller.com.br',
};

test('resolveHubBaseUrl: HUB_PUBLIC_URL tem prioridade, senão o primeiro ALLOWED_ORIGIN; sem barra no fim', () => {
  assert.equal(resolveHubBaseUrl({ HUB_PUBLIC_URL: 'https://hub.exemplo.com/', ALLOWED_ORIGIN: 'http://10.0.0.1:3000' }), 'https://hub.exemplo.com');
  assert.equal(resolveHubBaseUrl({ ALLOWED_ORIGIN: 'http://10.0.0.2:3000, http://outro' }), 'http://10.0.0.2:3000');
  assert.equal(resolveHubBaseUrl({}), null);
  assert.equal(resolveHubBaseUrl({ HUB_PUBLIC_URL: 'javascript:alert(1)', ALLOWED_ORIGIN: '' }), null);
  assert.equal(resolveHubBaseUrl({ HUB_PUBLIC_URL: 'hubcontroller.com.br' }), null);
});

test('resolveHubBaseUrl nunca devolve endereço local: pula para o próximo ou fica sem link', () => {
  for (const local of ['http://localhost:3100', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://0.0.0.0:3000', 'http://hub.localhost']) {
    assert.equal(resolveHubBaseUrl({ HUB_PUBLIC_URL: local }), null, local);
  }
  // HUB_PUBLIC_URL local é ignorado e o ALLOWED_ORIGIN não local assume
  assert.equal(resolveHubBaseUrl({ HUB_PUBLIC_URL: 'http://localhost:3100', ALLOWED_ORIGIN: 'http://10.0.0.2:3000' }), 'http://10.0.0.2:3000');
  // ALLOWED_ORIGIN com vários: pula os locais
  assert.equal(resolveHubBaseUrl({ ALLOWED_ORIGIN: 'http://localhost:5173, https://hubcontroller.com.br' }), 'https://hubcontroller.com.br');
  // só local (ambiente de desenvolvimento) → sem link
  assert.equal(resolveHubBaseUrl({ ALLOWED_ORIGIN: 'http://localhost:5173' }), null);
  assert.equal(isLocalAddress('https://hubcontroller.com.br'), false);
  assert.equal(isLocalAddress('http://10.0.0.2:3000'), false);
});

test('scheduleAlertsEnabled: ligado por padrão, desliga com false/0/off', () => {
  assert.equal(scheduleAlertsEnabled({}), true);
  assert.equal(scheduleAlertsEnabled({ SCHEDULE_ALERT_EMAILS: 'true' }), true);
  for (const off of ['false', 'FALSE', '0', 'off', 'não']) {
    assert.equal(scheduleAlertsEnabled({ SCHEDULE_ALERT_EMAILS: off }), false, off);
  }
});

test('executionLink aponta para a tela da execução e some sem endereço', () => {
  assert.equal(executionLink('https://h.com', 'abc'), 'https://h.com/executions/abc');
  assert.equal(executionLink(null, 'abc'), null);
  assert.equal(executionLink('http://localhost:3100', 'abc'), null);   // local nunca vira link
  const local = buildScheduledExecutionAlert({ ...base, baseUrl: 'http://127.0.0.1:3000' });
  assert.doesNotMatch(local.text, /localhost|127\.0\.0\.1|Abrir a execução/);
  assert.doesNotMatch(local.html, /localhost|127\.0\.0\.1|<a href/);
});

test('formatDuration', () => {
  const t = (s: number) => formatDuration(new Date(0), new Date(s * 1000));
  assert.equal(t(45), '45 s');
  assert.equal(t(17 * 60 + 30), '17 min');
  assert.equal(t(3600 + 5 * 60), '1 h 5 min');
  assert.equal(formatDuration(null, new Date()), '—');
});

test('e-mail de erro: assunto, motivo, link e duração', () => {
  const mail = buildScheduledExecutionAlert(base);
  assert.equal(mail.subject, '⚠️ Agendamento falhou: Atualização BI - Gestta — Gestta 06:30');
  assert.match(mail.text, /terminou com erro/);
  assert.match(mail.text, /Motivo: Falha ao baixar o relatório\./);
  assert.match(mail.text, /Duração: 17 min/);
  assert.match(mail.text, /Abrir a execução: https:\/\/hubcontroller\.com\.br\/executions\/cmabc123/);
  assert.match(mail.html, /href="https:\/\/hubcontroller\.com\.br\/executions\/cmabc123"/);
});

test('travamento e interrupção têm assunto e texto próprios', () => {
  const stalled = buildScheduledExecutionAlert({ ...base, kind: 'stalled' });
  assert.match(stalled.subject, /Agendamento travou/);
  assert.match(stalled.text, /travou e foi encerrada/);
  const interrupted = buildScheduledExecutionAlert({ ...base, kind: 'interrupted' });
  assert.match(interrupted.subject, /Agendamento interrompido/);
  assert.match(interrupted.text, /foi interrompida/);
});

test('sem endereço do Hub o e-mail sai sem link, e sem motivo avisa', () => {
  const mail = buildScheduledExecutionAlert({ ...base, baseUrl: null, errorMessage: null });
  assert.doesNotMatch(mail.text, /Abrir a execução/);
  assert.doesNotMatch(mail.html, /<a href/);
  assert.match(mail.text, /Sem detalhes registrados\./);
});

test('o motivo é encurtado e o HTML escapa o que veio do robô', () => {
  const longo = buildScheduledExecutionAlert({ ...base, errorMessage: `x${'a'.repeat(2000)}` });
  const motivo = longo.text.split('\n').find((l) => l.startsWith('Motivo: '))!;
  assert.ok(motivo.length <= 'Motivo: '.length + 600, String(motivo.length));
  const xss = buildScheduledExecutionAlert({ ...base, errorMessage: '<script>alert(1)</script> "x"', robotName: '<b>Robô</b>' });
  assert.doesNotMatch(xss.html, /<script>alert/);
  assert.doesNotMatch(xss.html, /<b>Robô<\/b>/);
  assert.match(xss.html, /&lt;script&gt;/);
});

test('início nulo (execução que nem começou) não quebra o e-mail', () => {
  const mail = buildScheduledExecutionAlert({ ...base, startedAt: null });
  assert.match(mail.text, /Início: —/);
  assert.match(mail.text, /Duração: —/);
});

test('cancelado por tempo máximo: assunto próprio e motivo', () => {
  const m = buildScheduledExecutionAlert({ ...base, kind: 'limit', errorMessage: 'Cancelada automaticamente: passou do tempo máximo (60 min desde o início). Não foi reiniciada.' });
  assert.equal(m.subject, '⛔ Agendamento cancelado por tempo: Atualização BI - Gestta — Gestta 06:30');
  assert.match(m.text, /passou do tempo máximo e foi cancelada/);
  assert.match(m.text, /Não foi reiniciada/);
});

test('"Não executou" aparece no e-mail de erro quando há agendamentos que dependiam desta execução', () => {
  const m = buildScheduledExecutionAlert({ ...base, skipped: ['Atualizar Planilhas Excel (BI) — Excel 06:55'] });
  assert.match(m.text, /Não executou: Atualizar Planilhas Excel \(BI\) — Excel 06:55/);
  assert.match(m.html, /Não executou/);
  const sem = buildScheduledExecutionAlert(base);
  assert.doesNotMatch(sem.text, /Não executou/);
  assert.doesNotMatch(sem.html, /Não executou/);
});
