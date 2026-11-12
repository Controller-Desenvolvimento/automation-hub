import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveMaxRuntime,
  hasTimeLimit,
  isOverLimit,
  limitReason,
  LIMIT_REASON_PREFIX,
  parseLimitField,
  t2Reason,
  T2_REASON_PREFIX,
} from '../src/scheduled-tasks/schedule-checks';
import { RESTART_GAP_MS, resolveCycle, type ExecSnap } from '../src/scheduled-tasks/schedule-dependency';
import { INTERRUPTED_BY_RESTART_MESSAGE } from '../src/executions/interrupted';

const now = new Date('2026-11-12T07:00:00');
const ago = (ms: number) => new Date(now.getTime() - ms);
const snap = (over: Partial<ExecSnap>): ExecSnap => ({ id: 'e1', status: 'running', attempt: 1, finishedAt: null, errorMessage: null, ...over });
const T = { verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10 };
const NO_T = { verifyT0Minutes: null, verifyT1Minutes: null, verifyT2Minutes: null };

test('ciclo: rodando ou na fila = pendente; sucesso = sucesso', () => {
  for (const status of ['running', 'queued'] as const) {
    assert.deepEqual(resolveCycle({ first: snap({ status }), restart: null, now, restartExpected: true }), { state: 'pending' });
  }
  assert.deepEqual(resolveCycle({ first: snap({ status: 'success', finishedAt: ago(1000) }), restart: null, now, restartExpected: true }), { state: 'success' });
});

test('ciclo: erro comum da 1ª tentativa (sem reinício esperado) = falhou, com o motivo', () => {
  const r = resolveCycle({ first: snap({ status: 'error', finishedAt: ago(1000), errorMessage: 'Download incompleto' }), restart: null, now, restartExpected: true });
  assert.equal(r.state, 'failed');
  assert.match((r as any).detail, /terminou com erro: Download incompleto/);
});

test('ciclo: cancelada em T2 e reinício ainda não criado = pendente (brecha); passou da carência = falhou', () => {
  const t2 = snap({ status: 'canceled', finishedAt: ago(10_000), errorMessage: t2Reason({ t0: 20, t1: 15, t2: 10 }) });
  assert.deepEqual(resolveCycle({ first: t2, restart: null, now, restartExpected: true }), { state: 'pending' });
  const velha = { ...t2, finishedAt: ago(RESTART_GAP_MS + 1000) };
  assert.equal(resolveCycle({ first: velha, restart: null, now, restartExpected: true }).state, 'failed');
});

test('ciclo: sem verificação, cancelada em T2 não existe; cancelamento sem reinício esperado = falhou na hora', () => {
  const t2 = snap({ status: 'canceled', finishedAt: ago(10_000), errorMessage: `${T2_REASON_PREFIX} (...)` });
  assert.equal(resolveCycle({ first: t2, restart: null, now, restartExpected: false }).state, 'failed');
});

test('ciclo: interrompida pelo reinício do Hub recente e com verificação = pendente até o reinício aparecer', () => {
  const int = snap({ status: 'error', finishedAt: ago(20_000), errorMessage: INTERRUPTED_BY_RESTART_MESSAGE });
  assert.deepEqual(resolveCycle({ first: int, restart: null, now, restartExpected: true }), { state: 'pending' });
  assert.equal(resolveCycle({ first: int, restart: null, now, restartExpected: false }).state, 'failed');
});

test('ciclo: com reinício, vale o desfecho do reinício', () => {
  const first = snap({ status: 'canceled', finishedAt: ago(600_000), errorMessage: `${T2_REASON_PREFIX} (...)` });
  const base = { first, now, restartExpected: true };
  assert.deepEqual(resolveCycle({ ...base, restart: snap({ id: 'e2', attempt: 2, status: 'running' }) }), { state: 'pending' });
  assert.deepEqual(resolveCycle({ ...base, restart: snap({ id: 'e2', attempt: 2, status: 'queued' }) }), { state: 'pending' });
  assert.deepEqual(resolveCycle({ ...base, restart: snap({ id: 'e2', attempt: 2, status: 'success', finishedAt: ago(1000) }) }), { state: 'success' });
  const falhou = resolveCycle({ ...base, restart: snap({ id: 'e2', attempt: 2, status: 'canceled', finishedAt: ago(1000), errorMessage: 'passou do T2 de novo' }) });
  assert.equal(falhou.state, 'failed');
  assert.match((falhou as any).detail, /foi cancelado: passou do T2 de novo/);
});

test('ciclo: cancelada à mão por uma pessoa conta como falha (nunca pendente)', () => {
  const manual = snap({ status: 'canceled', finishedAt: ago(5000), errorMessage: null });
  assert.equal(resolveCycle({ first: manual, restart: null, now, restartExpected: true }).state, 'failed');
});

test('ciclo: cancelada pelo teto de tempo = falhou na hora, mesmo "esperando reinício"', () => {
  const teto = snap({ status: 'canceled', finishedAt: ago(1000), errorMessage: limitReason(60) });
  assert.equal(resolveCycle({ first: teto, restart: null, now, restartExpected: true }).state, 'failed');
});

test('teto: só vale sem T0/T1/T2; hasTimeLimit aceita T ou teto', () => {
  assert.equal(effectiveMaxRuntime({ ...NO_T, maxRuntimeMinutes: 60 }), 60);
  assert.equal(effectiveMaxRuntime({ ...T, maxRuntimeMinutes: 60 }), null); // com T, o T2 já é o teto
  assert.equal(effectiveMaxRuntime({ ...NO_T, maxRuntimeMinutes: null }), null);
  assert.equal(effectiveMaxRuntime({ ...NO_T, maxRuntimeMinutes: 0 }), null);
  assert.equal(hasTimeLimit({ ...T, maxRuntimeMinutes: null }), true);
  assert.equal(hasTimeLimit({ ...NO_T, maxRuntimeMinutes: 90 }), true);
  assert.equal(hasTimeLimit({ ...NO_T, maxRuntimeMinutes: null }), false);
});

test('teto: passou do tempo contado do início; motivo tem o prefixo conhecido', () => {
  const start = new Date('2026-11-12T06:30:00');
  assert.equal(isOverLimit(start, new Date('2026-11-12T07:29:59'), 60), false);
  assert.equal(isOverLimit(start, new Date('2026-11-12T07:30:00'), 60), true);
  assert.ok(limitReason(60).startsWith(LIMIT_REASON_PREFIX));
  assert.match(limitReason(60), /Não foi reiniciada/);
});

test('parseLimitField: não enviado, vazio, válido, inválido', () => {
  assert.deepEqual(parseLimitField(undefined), { present: false });
  assert.deepEqual(parseLimitField(''), { present: true, ok: true, value: null });
  assert.deepEqual(parseLimitField(null), { present: true, ok: true, value: null });
  assert.deepEqual(parseLimitField('90'), { present: true, ok: true, value: 90 });
  for (const bad of ['0', '1441', 'abc', '2.5', -3]) assert.equal((parseLimitField(bad) as any).ok, false, String(bad));
});
