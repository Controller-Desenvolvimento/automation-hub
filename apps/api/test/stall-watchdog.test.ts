import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STALL_TIMEOUT_MINUTES,
  findStalledExecutions,
  getStallTimeoutMs,
  stallMessage,
} from '../src/executions/stall-watchdog';

const MIN = 60_000;

test('getStallTimeoutMs usa o padrão quando a variável falta ou é inválida', () => {
  const defaultMs = DEFAULT_STALL_TIMEOUT_MINUTES * MIN;
  assert.equal(getStallTimeoutMs({}), defaultMs);
  assert.equal(getStallTimeoutMs({ EXECUTION_STALL_TIMEOUT_MINUTES: '' }), defaultMs);
  assert.equal(getStallTimeoutMs({ EXECUTION_STALL_TIMEOUT_MINUTES: 'abc' }), defaultMs);
  assert.equal(getStallTimeoutMs({ EXECUTION_STALL_TIMEOUT_MINUTES: '-5' }), defaultMs);
});

test('getStallTimeoutMs respeita o valor configurado e 0 desliga', () => {
  assert.equal(getStallTimeoutMs({ EXECUTION_STALL_TIMEOUT_MINUTES: '30' }), 30 * MIN);
  assert.equal(getStallTimeoutMs({ EXECUTION_STALL_TIMEOUT_MINUTES: '60' }), 60 * MIN);
  assert.equal(getStallTimeoutMs({ EXECUTION_STALL_TIMEOUT_MINUTES: '0' }), 0);
});

test('findStalledExecutions pega só quem passou do limite sem atividade', () => {
  const now = 10_000 * MIN;
  const result = findStalledExecutions(
    [
      { executionId: 'ativa', lastActivityAt: now - 5 * MIN },
      { executionId: 'quase', lastActivityAt: now - 44 * MIN },
      { executionId: 'travada', lastActivityAt: now - 50 * MIN },
      { executionId: 'no-limite', lastActivityAt: now - 45 * MIN },
    ],
    now,
    45 * MIN,
  );
  assert.deepEqual(
    result.map((r) => r.executionId),
    ['travada', 'no-limite'],
  );
  assert.equal(result[0].idleMinutes, 50);
});

test('findStalledExecutions não faz nada com o watchdog desligado', () => {
  const now = 10_000 * MIN;
  assert.deepEqual(findStalledExecutions([{ executionId: 'x', lastActivityAt: 0 }], now, 0), []);
});

test('stallMessage informa os minutos parados', () => {
  assert.match(stallMessage(47), /47 minutos/);
});
