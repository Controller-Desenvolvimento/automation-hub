import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPLOY_PENDING_MAX_AGE_MS, parseDeployPending } from '../src/system/deploy-state';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const raw = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ sha: 'abc1234', message: 'feat: x', requestedAt: '2026-10-14T11:30:00Z', ...over });

test('pendente recente é lido', () => {
  const p = parseDeployPending(raw(), NOW);
  assert.equal(p?.sha, 'abc1234');
  assert.equal(p?.force, false);
});

test('pendente esquecido (script morreu) é ignorado pra não travar a fila', () => {
  const old = new Date(NOW - DEPLOY_PENDING_MAX_AGE_MS - 1000).toISOString();
  assert.equal(parseDeployPending(raw({ requestedAt: old }), NOW), null);
});

test('pendente logo abaixo do limite ainda vale', () => {
  const edge = new Date(NOW - DEPLOY_PENDING_MAX_AGE_MS + 1000).toISOString();
  assert.notEqual(parseDeployPending(raw({ requestedAt: edge }), NOW), null);
});

test('conteúdo inválido não derruba nada (vira "sem pendente")', () => {
  assert.equal(parseDeployPending('', NOW), null);
  assert.equal(parseDeployPending('{', NOW), null);
  assert.equal(parseDeployPending('null', NOW), null);
  assert.equal(parseDeployPending(raw({ sha: 123 }), NOW), null);
  assert.equal(parseDeployPending(raw({ requestedAt: 'ontem' }), NOW), null);
});

test('force só vale quando é exatamente true', () => {
  assert.equal(parseDeployPending(raw({ force: true }), NOW)?.force, true);
  assert.equal(parseDeployPending(raw({ force: 'true' }), NOW)?.force, false);
});
