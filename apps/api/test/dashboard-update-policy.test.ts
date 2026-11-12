import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeUpdateError,
  getCatchUpMs,
  getRetryDelayMs,
  isUpdateDue,
  lastScheduledSlot,
  type UpdateSchedule,
} from '../src/dashboard/update-policy';

const daily = (times: string[]): UpdateSchedule => ({ frequency: 'daily', timesOfDay: times, dayOfWeek: null, dayOfMonth: null });
const at = (iso: string) => new Date(iso); // sem "Z": hora local, como o servidor
const MIN = 60_000;

test('getCatchUpMs / getRetryDelayMs: padrões e valores inválidos', () => {
  assert.equal(getCatchUpMs({}), 60 * MIN);
  assert.equal(getCatchUpMs({ PANEL_UPDATE_CATCHUP_MINUTES: '90' }), 90 * MIN);
  assert.equal(getCatchUpMs({ PANEL_UPDATE_CATCHUP_MINUTES: 'x' }), 60 * MIN);
  assert.equal(getCatchUpMs({ PANEL_UPDATE_CATCHUP_MINUTES: '0' }), 60 * MIN);
  assert.equal(getRetryDelayMs({}), 5 * MIN);
  assert.equal(getRetryDelayMs({ PANEL_UPDATE_RETRY_MINUTES: '10' }), 10 * MIN);
  assert.equal(getRetryDelayMs({ PANEL_UPDATE_RETRY_MINUTES: '-3' }), 5 * MIN);
});

test('lastScheduledSlot: o horário mais recente que já passou, inclusive o de ontem', () => {
  const s = daily(['06:00', '12:00', '23:30']);
  assert.deepEqual(lastScheduledSlot(s, at('2026-11-12T12:20:00')), at('2026-11-12T12:00:00'));
  assert.deepEqual(lastScheduledSlot(s, at('2026-11-12T05:00:00')), at('2026-11-11T23:30:00'));
  assert.deepEqual(lastScheduledSlot(s, at('2026-11-12T06:00:00')), at('2026-11-12T06:00:00'));
  assert.equal(lastScheduledSlot({ ...s, frequency: null }, at('2026-11-12T12:20:00')), null);
  assert.equal(lastScheduledSlot(daily(['xx', '25:99', '7']), at('2026-11-12T12:20:00')), null);
});

test('lastScheduledSlot: semanal e mensal só valem no dia certo', () => {
  // 12/11/2026 é quinta-feira (getDay = 4)
  const weekly: UpdateSchedule = { frequency: 'weekly', timesOfDay: ['08:00'], dayOfWeek: 4, dayOfMonth: null };
  assert.deepEqual(lastScheduledSlot(weekly, at('2026-11-12T09:00:00')), at('2026-11-12T08:00:00'));
  assert.equal(lastScheduledSlot({ ...weekly, dayOfWeek: 6 }, at('2026-11-12T09:00:00')), null); // sábado: nenhum nos últimos 2 dias
  const monthly: UpdateSchedule = { frequency: 'monthly', timesOfDay: ['08:00'], dayOfWeek: null, dayOfMonth: 12 };
  assert.deepEqual(lastScheduledSlot(monthly, at('2026-11-12T09:00:00')), at('2026-11-12T08:00:00'));
  assert.equal(lastScheduledSlot({ ...monthly, dayOfMonth: 5 }, at('2026-11-12T09:00:00')), null);
});

test('isUpdateDue: no minuto do horário e logo depois, se ninguém atualizou ainda', () => {
  const s = daily(['06:00']);
  const base = { schedule: s, catchUpMs: 60 * MIN };
  assert.equal(isUpdateDue({ ...base, lastUpdateAt: at('2026-11-11T06:01:00'), now: at('2026-11-12T06:00:20') }), true);
  assert.equal(isUpdateDue({ ...base, lastUpdateAt: null, now: at('2026-11-12T06:00:20') }), true);
});

test('isUpdateDue: Hub fora do ar no minuto exato → recupera dentro da janela, e só uma vez', () => {
  const s = daily(['06:00']);
  const base = { schedule: s, catchUpMs: 60 * MIN };
  const ontem = at('2026-11-11T06:02:00');
  assert.equal(isUpdateDue({ ...base, lastUpdateAt: ontem, now: at('2026-11-12T06:25:00') }), true);   // voltou 06:25
  assert.equal(isUpdateDue({ ...base, lastUpdateAt: at('2026-11-12T06:26:30'), now: at('2026-11-12T06:27:00') }), false); // já rodou
  assert.equal(isUpdateDue({ ...base, lastUpdateAt: ontem, now: at('2026-11-12T07:01:00') }), false);  // passou da janela
});

test('isUpdateDue: tentativa que falhou também encerra o horário (a repetição é tratada à parte)', () => {
  const base = { schedule: daily(['06:00']), catchUpMs: 60 * MIN };
  assert.equal(isUpdateDue({ ...base, lastUpdateAt: at('2026-11-12T06:03:00'), now: at('2026-11-12T06:04:00') }), false);
});

test('isUpdateDue: sem frequência ou sem horário nunca está devido', () => {
  const base = { lastUpdateAt: null, catchUpMs: 60 * MIN, now: at('2026-11-12T06:00:20') };
  assert.equal(isUpdateDue({ ...base, schedule: { frequency: null, timesOfDay: ['06:00'], dayOfWeek: null, dayOfMonth: null } }), false);
  assert.equal(isUpdateDue({ ...base, schedule: daily([]) }), false);
});

test('describeUpdateError: timeout, causa de rede, corpo da resposta e texto longo', () => {
  const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  assert.match(describeUpdateError(timeout), /tempo limite/);
  const net = new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
  assert.equal(describeUpdateError(net), 'fetch failed (causa: ECONNREFUSED)');
  assert.equal(describeUpdateError(new Error('Update endpoint responded with status 500'), '{"detail":"banco fora"}'),
    'Update endpoint responded with status 500 — {"detail":"banco fora"}');
  assert.ok(describeUpdateError(new Error('x'.repeat(2000))).length <= 500);
  assert.equal(describeUpdateError('texto solto'), 'texto solto');
});

test('isIntentionallyStopped: só "stopped" conta como parado de propósito', async () => {
  const { isIntentionallyStopped } = await import('../src/dashboard/update-policy');
  assert.equal(isIntentionallyStopped('stopped'), true);
  for (const s of ['running', 'error', null, undefined, '']) assert.equal(isIntentionallyStopped(s), false, String(s));
});
