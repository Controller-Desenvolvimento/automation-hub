import assert from 'node:assert/strict';
import test from 'node:test';
import { CATEGORY_INFO, ERROR_CATEGORIES, classifyError } from '../src/robot-health/error-causes';
import {
  autoGranularity,
  bucketStart,
  bucketKeys,
  byRobot,
  categorySeries,
  durationSeries,
  evolutionSeries,
  heatGranularity,
  heatmapGrid,
  dayKey,
  parseDay,
  previousPeriod,
  resolvePeriod,
  situationOf,
  summarize,
  topCauses,
  type HealthExecution,
} from '../src/robot-health/robot-health-metrics';

const at = (day: number, hour = 10) => new Date(2026, 10, day, hour, 0, 0); // 2026-11-DD (fuso local)
let seq = 0;
const exec = (over: Partial<HealthExecution> = {}): HealthExecution => ({
  id: `e${++seq}`, robotId: 'r1', status: 'success', createdAt: at(10), startedAt: at(10), finishedAt: new Date(at(10).getTime() + 60_000),
  scheduled: false, errorMessage: null, ...over,
});
const err = (message: string, over: Partial<HealthExecution> = {}) => exec({ status: 'error', errorMessage: message, ...over });

test('causas: cada mensagem real cai na categoria combinada', () => {
  const cat = (m: string) => classifyError(m).category;
  assert.equal(cat('Execução interrompida: o servidor do Hub foi reiniciado enquanto rodava'), 'hub');
  assert.equal(cat('Execução cancelada automaticamente: o robô ficou 45 minutos sem nenhuma atividade (nenhuma saída nem log) e foi considerado travado.'), 'robo', 'travou 45 min = Robô');
  assert.equal(cat('HTTP 503 Service Unavailable'), 'externo');
  assert.equal(classifyError('HTTP 404 não encontrado').cause, 'Portal recusou o pedido (HTTP 4xx)');
  assert.equal(classifyError('HTTP 503').cause, 'Portal com falha interna (HTTP 5xx)');
  assert.equal(cat('Certificado digital VENCIDO'), 'entrada');
  assert.equal(cat('A planilha precisa ter uma coluna "CNPJ"'), 'entrada');
  assert.equal(cat('Login recusado pelo portal'), 'entrada');
  assert.equal(cat('selenium.common.exceptions.NoSuchElementException'), 'robo');
  assert.equal(cat("KeyError: 'competencia'"), 'robo');
  assert.equal(cat('O robô "x" não possui comando configurado'), 'config');
  assert.equal(cat('Comando finalizado com codigo 1'), 'sem');
  assert.equal(classifyError('Comando finalizado com codigo 3221225786').cause, 'Processo encerrado à força (código 3221225786)');
  assert.equal(classifyError('algo que ninguém conhece').fallback, true);
  assert.equal(classifyError(null).category, 'sem');
  assert.equal(classifyError('Comando finalizado com codigo 1').fallback, false);
});

test('categorias: são 6, todas com explicação para o "i", e só Hub fica fora da conta do robô', () => {
  assert.deepEqual([...ERROR_CATEGORIES].sort(), ['config', 'entrada', 'externo', 'hub', 'robo', 'sem']);
  for (const key of ERROR_CATEGORIES) {
    const info = CATEGORY_INFO[key];
    assert.ok(info.label && info.summary && info.example && info.who, key);
  }
  assert.deepEqual(ERROR_CATEGORIES.filter((c) => !CATEGORY_INFO[c].countsAgainstRobot), ['hub']);
});

test('situação: poucos dados, atenção a partir de 15%, crítico a partir de 40%', () => {
  assert.equal(situationOf(4, 4), 'few', 'menos de 5 concluídas: poucos dados, mesmo com 100% de erro');
  assert.equal(situationOf(5, 0), 'healthy');
  assert.equal(situationOf(20, 2), 'healthy', '10%');
  assert.equal(situationOf(20, 3), 'attention', '15%');
  assert.equal(situationOf(20, 7), 'attention', '35%');
  assert.equal(situationOf(10, 4), 'critical', '40%');
  assert.equal(situationOf(10, 10), 'critical');
});

test('totais: erro do Hub e cancelada ficam fora da taxa; duração só de sucesso', () => {
  const list = [
    exec(), exec(), exec(), // 3 sucessos de 60 s
    err("KeyError: 'x'"), // erro do robô
    err('Execução interrompida: o servidor do Hub foi reiniciado'), // erro do Hub
    exec({ status: 'canceled' }),
  ];
  const t = summarize(list);
  assert.equal(t.executions, 6);
  assert.equal(t.success, 3);
  assert.equal(t.errors, 1, 'o erro do Hub não conta contra o robô');
  assert.equal(t.hubErrors, 1);
  assert.equal(t.canceled, 1);
  assert.equal(t.concluded, 4);
  assert.equal(t.successRate, 0.75);
  assert.equal(t.errorRate, 0.25);
  assert.equal(t.avgDurationSeconds, 60);
  const vazio = summarize([]);
  assert.equal(vazio.successRate, null);
  assert.equal(vazio.avgDurationSeconds, null);
});

test('por robô: situação, causa principal (sem Hub), última execução e taxa de erro do período anterior', () => {
  const cur = [
    ...Array.from({ length: 6 }, () => exec({ robotId: 'a' })),
    ...Array.from({ length: 4 }, () => err("KeyError: 'x'", { robotId: 'a' })),
    err('HTTP 503', { robotId: 'a' }),
    ...Array.from({ length: 3 }, () => exec({ robotId: 'b' })),
    ...Array.from({ length: 6 }, () => err('Execução interrompida: o servidor do Hub foi reiniciado', { robotId: 'b' })),
  ];
  const prev = Array.from({ length: 10 }, (_, i) => (i < 2 ? err("KeyError: 'x'", { robotId: 'a' }) : exec({ robotId: 'a' })));
  const rows = byRobot(cur, prev);
  const a = rows.find((r) => r.robotId === 'a')!;
  assert.equal(a.situation, 'critical', '5 erros em 11 concluídas');
  assert.deepEqual(a.mainCause, { cause: 'Exceção não tratada no robô', category: 'robo', count: 4 });
  assert.equal(a.previousErrorRate, 0.2);
  const b = rows.find((r) => r.robotId === 'b')!;
  assert.equal(b.hubErrors, 6);
  assert.equal(b.situation, 'few', 'só 3 concluídas (os erros do Hub não contam)');
  assert.equal(b.mainCause, null, 'sem erro do robô, sem causa principal');
  assert.equal(b.previousErrorRate, null, 'sem período anterior suficiente');
});

test('erros por categoria: baldes por dia sem buracos e semana de segunda a domingo', () => {
  const list = [err("KeyError: 'x'", { createdAt: at(10) }), err('HTTP 500', { createdAt: at(10) }), err('Comando finalizado com codigo 1', { createdAt: at(12) }), exec({ createdAt: at(11) })];
  const days = categorySeries(list, at(9), at(13), 'day');
  assert.deepEqual(days.map((b) => b.start), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.deepEqual(days.map((b) => b.total), [0, 2, 0, 1, 0], 'sucesso não entra');
  assert.equal(days[1].counts.robo, 1);
  assert.equal(days[1].counts.externo, 1);
  assert.equal(days[3].counts.sem, 1);
  // 2026-11-18 é quarta: a semana começa na segunda 16
  assert.equal(dayKey(bucketStart(new Date(2026, 10, 18), 'week')), '2026-11-16');
  assert.equal(dayKey(bucketStart(new Date(2026, 10, 22), 'week')), '2026-11-16', 'domingo ainda é da semana de segunda 16');
  assert.equal(dayKey(bucketStart(new Date(2026, 10, 18), 'month')), '2026-11-01');
  const months = categorySeries([err('HTTP 500', { createdAt: new Date(2026, 9, 5) })], new Date(2026, 8, 20), new Date(2026, 10, 18), 'month');
  assert.deepEqual(months.map((b) => b.start), ['2026-09-01', '2026-10-01', '2026-11-01']);
  assert.deepEqual(months.map((b) => b.total), [0, 1, 0]);
  assert.equal(autoGranularity(30), 'day');
  assert.equal(autoGranularity(90), 'week');
  assert.equal(autoGranularity(365), 'month');
});

test('principais causas: contagem, robôs distintos e ordem', () => {
  const list = [
    err("KeyError: 'x'", { robotId: 'a' }), err("KeyError: 'y'", { robotId: 'b' }), err("KeyError: 'z'", { robotId: 'a' }),
    err('HTTP 503', { robotId: 'a' }), exec(),
  ];
  const causes = topCauses(list);
  assert.deepEqual(causes.map((c) => [c.cause, c.count, c.robots]), [['Exceção não tratada no robô', 3, 2], ['Portal com falha interna (HTTP 5xx)', 1, 1]]);
});

test('período: padrão 30 dias, anterior do mesmo tamanho, datas inválidas e trocadas', () => {
  const now = new Date(2026, 10, 18, 15, 0, 0);
  const p = resolvePeriod(undefined, undefined, now);
  assert.equal(dayKey(p.from), '2026-10-20');
  assert.equal(dayKey(p.to), '2026-11-18');
  assert.equal(p.days, 30);
  const prev = previousPeriod(p);
  assert.equal(dayKey(prev.from), '2026-09-20');
  assert.equal(dayKey(prev.to), '2026-10-19');
  assert.equal(prev.days, 30);
  const trocado = resolvePeriod('2026-11-10', '2026-11-01', now);
  assert.equal(dayKey(trocado.from), '2026-11-01');
  assert.equal(trocado.days, 10);
  assert.equal(dayKey(resolvePeriod('2026-11-01', '2030-01-01', now).to), '2026-11-18', 'futuro vira hoje');
  assert.equal(dayKey(resolvePeriod('lixo', '2026-02-31', now).to), '2026-11-18', 'data inexistente é ignorada');
  assert.equal(parseDay('2026-02-30'), null);
  assert.ok(parseDay('2026-02-28'));
  assert.equal(resolvePeriod('2000-01-01', undefined, now).days, 1830, 'teto de ~5 anos');
});

const mins = (n: number) => n * 60_000;

test('evolução: um balde por dia, taxa e duração do balde, buraco vira "sem dados"', () => {
  const list = [
    exec({ createdAt: at(10), finishedAt: new Date(at(10).getTime() + mins(2)) }),
    exec({ createdAt: at(10), finishedAt: new Date(at(10).getTime() + mins(4)) }),
    err("KeyError: 'x'", { createdAt: at(10) }),
    err('Execução interrompida: o servidor do Hub foi reiniciado', { createdAt: at(12) }),
    exec({ status: 'canceled', createdAt: at(12) }),
  ];
  const days = evolutionSeries(list, at(9), at(13), 'day');
  assert.deepEqual(days.map((d) => d.start), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  const d10 = days[1];
  assert.equal(d10.success, 2);
  assert.equal(d10.errors, 1);
  assert.equal(d10.concluded, 3);
  assert.ok(Math.abs(d10.successRate! - 2 / 3) < 1e-9);
  assert.equal(d10.avgDurationSeconds, 180, 'média de 2 e 4 minutos');
  assert.equal(days[0].successRate, null, 'dia sem execução: sem taxa (não é 0%)');
  const d12 = days[3];
  assert.equal(d12.hubErrors, 1);
  assert.equal(d12.errors, 0);
  assert.equal(d12.canceled, 1);
  assert.equal(d12.successRate, null, 'só erro do Hub e cancelada: nada concluído');
  assert.deepEqual(bucketKeys(new Date(2026, 10, 18), new Date(2026, 10, 30), 'week'), ['2026-11-16', '2026-11-23', '2026-11-30']);
});

test('duração por robô: só sucessos, por balde, com o número de execuções', () => {
  const list = [
    exec({ robotId: 'a', createdAt: at(10), finishedAt: new Date(at(10).getTime() + mins(10)) }),
    exec({ robotId: 'a', createdAt: at(10), finishedAt: new Date(at(10).getTime() + mins(20)) }),
    err('HTTP 500', { robotId: 'a', createdAt: at(10), finishedAt: new Date(at(10).getTime() + mins(99)) }),
    exec({ robotId: 'b', createdAt: at(11), startedAt: at(11), finishedAt: new Date(at(11).getTime() + mins(1)) }),
  ];
  const series = durationSeries(list, ['a', 'b'], at(10), at(12), 'day');
  assert.equal(series[0].robotId, 'a');
  assert.deepEqual(series[0].points.map((p) => [p.start, p.avgSeconds, p.n]), [['2026-11-10', 900, 2], ['2026-11-11', null, 0], ['2026-11-12', null, 0]]);
  assert.equal(series[1].points[1].avgSeconds, 60);
});

test('mapa robô × dia: contagens por célula (sucesso, erro do robô, erro do Hub, cancelada)', () => {
  const list = [
    exec({ robotId: 'a', createdAt: at(10) }), exec({ robotId: 'a', createdAt: at(10) }),
    err("KeyError: 'x'", { robotId: 'a', createdAt: at(10) }),
    err('Execução interrompida: o servidor do Hub foi reiniciado', { robotId: 'a', createdAt: at(11) }),
    exec({ status: 'canceled', robotId: 'b', createdAt: at(11) }),
  ];
  const grid = heatmapGrid(list, at(10), at(12), 'day');
  assert.deepEqual(grid.buckets, ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual(grid.rows.find((r) => r.robotId === 'a')!.cells, [[2, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 0]]);
  assert.deepEqual(grid.rows.find((r) => r.robotId === 'b')!.cells, [[0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0]]);
  assert.equal(grid.rows.length, 2, 'só robôs que rodaram');
  assert.equal(heatGranularity(30), 'day');
  assert.equal(heatGranularity(62), 'day');
  assert.equal(heatGranularity(90), 'week');
  assert.equal(heatGranularity(181), 'month');
});

