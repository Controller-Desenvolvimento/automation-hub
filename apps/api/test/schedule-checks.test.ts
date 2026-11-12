import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkConfigFromTask,
  checkMarks,
  decideCheck,
  markTimes,
  parseCheckFields,
  type CheckConfig,
} from '../src/scheduled-tasks/schedule-checks';

const cfg: CheckConfig = { t0: 20, t1: 15, t2: 10 }; // T0=20, T1=35, T2=45 (o exemplo combinado)
const start = new Date('2026-11-12T06:30:00');
const at = (min: number) => new Date(start.getTime() + min * 60_000);

test('checkConfigFromTask: só vale com os três valores; senão é "sem verificação"', () => {
  assert.deepEqual(checkConfigFromTask({ verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10 }), cfg);
  assert.equal(checkConfigFromTask({ verifyT0Minutes: null, verifyT1Minutes: null, verifyT2Minutes: null }), null);
  assert.equal(checkConfigFromTask({ verifyT0Minutes: 20, verifyT1Minutes: null, verifyT2Minutes: 10 }), null);
  assert.equal(checkConfigFromTask({ verifyT0Minutes: 0, verifyT1Minutes: 15, verifyT2Minutes: 10 }), null);
});

test('marcos: T1 = T0 + 15 e T2 = T1 + 10, contados do início', () => {
  assert.deepEqual(checkMarks(cfg), { t0: 20, t1: 35, t2: 45 });
  const t = markTimes(start, cfg);
  assert.deepEqual(t.t0, new Date('2026-11-12T06:50:00'));
  assert.deepEqual(t.t1, new Date('2026-11-12T07:05:00'));
  assert.deepEqual(t.t2, new Date('2026-11-12T07:15:00'));
});

test('1ª tentativa: nada antes de T0; aviso em T0; aviso em T1; cancela em T2', () => {
  const d = (min: number, stage: number) => decideCheck({ startedAt: start, now: at(min), attempt: 1, checkStage: stage, cfg });
  assert.deepEqual(d(19.9, 0), { action: 'none' });
  assert.deepEqual(d(20, 0), { action: 'notify', stage: 1 });
  assert.deepEqual(d(25, 1), { action: 'none' });          // já avisou T0, ainda não é T1
  assert.deepEqual(d(35, 1), { action: 'notify', stage: 2 });
  assert.deepEqual(d(40, 2), { action: 'none' });          // já avisou T1, ainda não é T2
  assert.deepEqual(d(45, 2), { action: 'cancel' });
  assert.deepEqual(d(300, 2), { action: 'cancel' });
});

test('1ª tentativa: nunca repete o mesmo aviso (checkStage)', () => {
  const d = (min: number, stage: number) => decideCheck({ startedAt: start, now: at(min), attempt: 1, checkStage: stage, cfg });
  assert.deepEqual(d(21, 1), { action: 'none' });
  assert.deepEqual(d(36, 2), { action: 'none' });
});

test('relógio andou mais de um marco: vale só o mais avançado, e passou de T2 cancela direto', () => {
  const d = (min: number, stage: number) => decideCheck({ startedAt: start, now: at(min), attempt: 1, checkStage: stage, cfg });
  assert.deepEqual(d(36, 0), { action: 'notify', stage: 2 }); // pulou o T0
  assert.deepEqual(d(50, 0), { action: 'cancel' });           // pulou T0 e T1
});

test('2ª tentativa (reinício): sem avisos intermediários; só cancela em T2', () => {
  const d = (min: number, stage = 0) => decideCheck({ startedAt: start, now: at(min), attempt: 2, checkStage: stage, cfg });
  assert.deepEqual(d(20), { action: 'none' });
  assert.deepEqual(d(35), { action: 'none' });
  assert.deepEqual(d(44.9), { action: 'none' });
  assert.deepEqual(d(45), { action: 'cancel' });
});

test('parseCheckFields: não enviado, em branco, válido e inválido', () => {
  assert.deepEqual(parseCheckFields({}), { present: false });
  const limpo = parseCheckFields({ verifyT0Minutes: '', verifyT1Minutes: null, verifyT2Minutes: undefined });
  assert.deepEqual(limpo, { present: true, ok: true, value: { verifyT0Minutes: null, verifyT1Minutes: null, verifyT2Minutes: null } });
  const ok = parseCheckFields({ verifyT0Minutes: '20', verifyT1Minutes: 15, verifyT2Minutes: ' 10 ' });
  assert.deepEqual(ok, { present: true, ok: true, value: { verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10 } });
  for (const bad of [
    { verifyT0Minutes: 20, verifyT1Minutes: '', verifyT2Minutes: 10 },   // faltou um
    { verifyT0Minutes: 0, verifyT1Minutes: 15, verifyT2Minutes: 10 },
    { verifyT0Minutes: 20.5, verifyT1Minutes: 15, verifyT2Minutes: 10 },
    { verifyT0Minutes: 'abc', verifyT1Minutes: 15, verifyT2Minutes: 10 },
    { verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 1441 },
  ]) {
    const r = parseCheckFields(bad);
    assert.equal(r.present && r.ok, false, JSON.stringify(bad));
  }
});
