import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRestartFailedAlert,
  buildScheduleSlowAlert,
  formatClock,
  type RestartFailedInput,
  type SlowAlertInput,
} from '../src/mail/schedule-check-alert';

const start = new Date('2026-11-12T09:30:00Z'); // 06:30 em Brasília
const slow: SlowAlertInput = {
  stage: 1,
  robotName: 'Atualização BI - Gestta',
  scheduleName: 'Gestta 06:30',
  executionId: 'cmabc123',
  startedAt: start,
  now: new Date(start.getTime() + 20 * 60_000),
  t1At: new Date(start.getTime() + 35 * 60_000),
  t2At: new Date(start.getTime() + 45 * 60_000),
  baseUrl: 'https://hubcontroller.com.br',
};

test('formatClock usa o horário de Brasília', () => {
  assert.equal(formatClock(new Date('2026-11-12T09:50:00Z')), '06:50');
});

test('aviso T0: diz há quanto tempo roda, quando é o próximo aviso e o cancelamento em T2', () => {
  const m = buildScheduleSlowAlert(slow);
  assert.equal(m.subject, '⏳ Agendamento demorando: Atualização BI - Gestta — Gestta 06:30');
  assert.match(m.text, /está demorando mais que o esperado/);
  assert.match(m.text, /Rodando há: 20 min/);
  assert.match(m.text, /Novo aviso às 07:05\. Se ainda estiver rodando às 07:15, será cancelada e reiniciada/);
  assert.match(m.text, /Abrir a execução: https:\/\/hubcontroller\.com\.br\/executions\/cmabc123/);
  assert.match(m.html, /href="https:\/\/hubcontroller\.com\.br\/executions\/cmabc123"/);
});

test('aviso T1: 2º aviso, sem prometer outro aviso, e com o horário do cancelamento', () => {
  const m = buildScheduleSlowAlert({ ...slow, stage: 2, now: new Date(start.getTime() + 35 * 60_000) });
  assert.match(m.subject, /^⏳ 2º aviso: agendamento ainda em execução/);
  assert.match(m.text, /Rodando há: 35 min/);
  assert.match(m.text, /às 07:15, será cancelada e reiniciada automaticamente \(uma vez\)\. Vale conferir agora/);
  assert.doesNotMatch(m.text, /Novo aviso/);
});

test('aviso de demora sem endereço válido sai sem link', () => {
  const m = buildScheduleSlowAlert({ ...slow, baseUrl: 'http://localhost:3000' });
  assert.doesNotMatch(m.text, /Abrir a execução|localhost/);
  assert.doesNotMatch(m.html, /<a href|localhost/);
});

const restart: RestartFailedInput = {
  robotName: 'Atualização BI - Gestta',
  scheduleName: 'Gestta 06:30',
  first: { executionId: 'e1', startedAt: start, finishedAt: new Date(start.getTime() + 45 * 60_000), outcome: 'Cancelada automaticamente: passou de 45 min (T2).' },
  second: { executionId: 'e2', startedAt: new Date(start.getTime() + 46 * 60_000), finishedAt: new Date(start.getTime() + 91 * 60_000), outcome: 'Cancelada automaticamente: passou de 45 min (T2).' },
  baseUrl: 'https://hubcontroller.com.br',
};

test('e-mail final do reinício: assunto chamativo, as duas tentativas e os dois links', () => {
  const m = buildRestartFailedAlert(restart);
  assert.equal(m.subject, '🚨 REINICIADA e continua com problema: Atualização BI - Gestta — Gestta 06:30');
  assert.match(m.text, /foi REINICIADA automaticamente e CONTINUA COM PROBLEMA/);
  assert.match(m.text, /1ª tentativa: .*\(45 min\) — Cancelada automaticamente/);
  assert.match(m.text, /2ª \(reinício\): .*\(45 min\) — Cancelada automaticamente/);
  assert.match(m.text, /não será tentada de novo automaticamente/);
  assert.match(m.text, /Abrir o reinício: https:\/\/hubcontroller\.com\.br\/executions\/e2/);
  assert.match(m.text, /Abrir a execução original: https:\/\/hubcontroller\.com\.br\/executions\/e1/);
  assert.match(m.html, /href="https:\/\/hubcontroller\.com\.br\/executions\/e2"/);
  assert.match(m.html, /href="https:\/\/hubcontroller\.com\.br\/executions\/e1"/);
  assert.doesNotMatch(m.text, /Não executou/);
});

test('e-mail final lista o que deixou de rodar por causa disso e escapa o texto vindo do robô', () => {
  const m = buildRestartFailedAlert({
    ...restart,
    skipped: ['Atualizar Planilhas Excel (BI) — Excel 06:55'],
    second: { ...restart.second, outcome: '<script>alert(1)</script>' },
  });
  assert.match(m.text, /Não executou: Atualizar Planilhas Excel \(BI\) — Excel 06:55/);
  assert.doesNotMatch(m.html, /<script>alert/);
  assert.match(m.html, /&lt;script&gt;/);
});

test('e-mail final sem endereço válido sai sem links, e motivo vazio avisa', () => {
  const m = buildRestartFailedAlert({ ...restart, baseUrl: null, first: { ...restart.first, outcome: null } });
  assert.doesNotMatch(m.text, /Abrir/);
  assert.doesNotMatch(m.html, /<a href/);
  assert.match(m.text, /sem detalhes registrados/);
});
