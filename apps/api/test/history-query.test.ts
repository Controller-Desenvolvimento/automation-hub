import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_MAX_PAGE_SIZE, historyBaseWhere, historyOriginWhere, parseHistoryQuery } from '../src/executions/history-query';

test('sem parâmetros: padrão (página 1, 10 por página, todas as origens, sem filtros)', () => {
  const q = parseHistoryQuery({});
  assert.deepEqual([q.page, q.pageSize, q.origin, q.statuses.length], [1, 10, 'all', 0]);
  assert.deepEqual(historyBaseWhere(q), {});
});

test('valores inválidos viram o padrão e o tamanho da página tem teto', () => {
  const q = parseHistoryQuery({ page: '-3', pageSize: '9999', origin: 'x', status: 'error,foo,error,success', from: '2026-13-99', to: 'abc' });
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, HISTORY_MAX_PAGE_SIZE);
  assert.equal(q.origin, 'all');
  assert.deepEqual(q.statuses, ['error', 'success']);
  assert.equal(q.from, undefined);
  assert.equal(q.to, undefined);
});

test('filtros de robô, período e busca entram no where; origem tem filtro próprio', () => {
  const q = parseHistoryQuery({ robotId: 'r1', q: ' dam ', from: '2026-11-01', to: '2026-11-30', origin: 'scheduled' });
  assert.equal(q.q, 'dam');
  assert.equal(q.to?.getDate(), 30);
  assert.equal(q.to?.getHours(), 23);
  const where = historyBaseWhere(q) as { AND: unknown[] };
  assert.equal(where.AND.length, 3);
  assert.deepEqual(historyOriginWhere(q.origin), { scheduledTaskId: { not: null } });
  assert.deepEqual(historyOriginWhere('manual'), { scheduledTaskId: null });
  assert.deepEqual(historyOriginWhere('all'), {});
});
