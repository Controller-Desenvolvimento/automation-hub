import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTimeSavingsInput, summarizeMetricLogs } from '../src/reports/robots-without-gain';

test('métricas dos logs: soma por chave e conta em quantas execuções apareceu', () => {
  const rows = [
    { executionId: 'e1', message: 'Metrica registrada: empresas=10' },
    { executionId: 'e1', message: 'Metrica registrada: empresas=5' },
    { executionId: 'e2', message: 'Metrica registrada: empresas=3' },
    { executionId: 'e2', message: 'Metrica registrada: notas=7.5' },
    { executionId: 'e3', message: 'Outra coisa qualquer' },
    { executionId: 'e3', message: 'Metrica registrada: ruim=abc' },
  ];
  const m = summarizeMetricLogs(rows);
  assert.deepEqual(m, [
    { key: 'empresas', executions: 2, total: 18 },
    { key: 'notas', executions: 1, total: 7.5 },
  ]);
  assert.deepEqual(summarizeMetricLogs([]), []);
});

test('tempo manual: valida os 3 campos e limpa a chave da métrica', () => {
  const ok = parseTimeSavingsInput({ manualSecondsPerUnit: 300, unitLabel: '  empresa  ', unitMetricKey: ' Empresas Processadas ' });
  assert.deepEqual(ok, { ok: true, value: { manualSecondsPerUnit: 300, unitLabel: 'empresa', unitMetricKey: 'empresas_processadas' } });
  const dflt = parseTimeSavingsInput({ manualSecondsPerUnit: '90.4', unitLabel: 'nota', unitMetricKey: '' });
  assert.deepEqual(dflt, { ok: true, value: { manualSecondsPerUnit: 90, unitLabel: 'nota', unitMetricKey: 'itens_processados' } });
});

test('tempo manual: recusa vazio, zero, negativo, absurdo, sem nome do item e nome longo', () => {
  const bad = (input: Record<string, unknown>) => {
    const r = parseTimeSavingsInput(input);
    assert.equal(r.ok, false);
    return (r as { message: string }).message;
  };
  assert.match(bad({ unitLabel: 'x' }), /tempo manual/i);
  assert.match(bad({ manualSecondsPerUnit: '', unitLabel: 'x' }), /tempo manual/i);
  assert.match(bad({ manualSecondsPerUnit: 'abc', unitLabel: 'x' }), /tempo manual/i);
  assert.match(bad({ manualSecondsPerUnit: 0, unitLabel: 'x' }), /pelo menos 1 segundo/);
  assert.match(bad({ manualSecondsPerUnit: -5, unitLabel: 'x' }), /pelo menos 1 segundo/);
  assert.match(bad({ manualSecondsPerUnit: 86_401, unitLabel: 'x' }), /24 horas/);
  assert.match(bad({ manualSecondsPerUnit: 60, unitLabel: '   ' }), /o que é um item/);
  assert.match(bad({ manualSecondsPerUnit: 60, unitLabel: 'a'.repeat(41) }), /40 caracteres/);
});
