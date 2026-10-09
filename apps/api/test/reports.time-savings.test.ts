import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '@prisma/client';
import { ReportsService } from '../src/reports/reports.service';

const NOW = new Date('2026-10-05T15:00:00.000Z');

const admin = { id: 'admin-1', role: UserRole.admin, departments: [] };

type FakeExecution = ReturnType<typeof execution>;

function execution(id: string, login: string, savedSeconds: number, finishedAt: string) {
  const at = new Date(finishedAt);
  return {
    id,
    createdAt: at,
    finishedAt: at,
    robotId: 'robot-1',
    userId: null as string | null,
    scheduledTaskId: null,
    unitsProcessed: null as number | null,
    manualEstimatedSeconds: savedSeconds as number | null,
    requestedByName: login,
    requestedByEmail: null as string | null,
    robot: {
      name: 'Robo externo',
      unitLabel: 'item',
      manualSecondsPerUnit: 0,
      allowedDepartments: [] as string[],
      isExternal: true,
    },
    user: null,
  };
}

function createService(executions: FakeExecution[], options: { firstDataAt?: Date } = {}) {
  const prisma = {
    scheduledTask: { findMany: async () => [] },
    user: { findMany: async () => [] },
    externalIdentity: { findMany: async () => [] },
    execution: {
      findMany: async (query: Record<string, unknown>) => (query.cursor ? [] : executions),
      findFirst: async () =>
        options.firstDataAt
          ? { finishedAt: options.firstDataAt, createdAt: options.firstDataAt }
          : null,
    },
    externalMetric: { findMany: async () => [], findFirst: async () => null },
  };
  const service = new ReportsService(prisma as never);
  service.clock = () => NOW;
  return service;
}

test('execucoes sem ganho nao contam como execucoes nem automacoes com ganho', async () => {
  const service = createService([
    execution('e1', 'maria.silva', 600, '2026-07-22T12:00:00.000Z'),
    execution('e2', 'maria.silva', 0, '2026-07-22T13:00:00.000Z'),
    execution('e3', 'maria.silva', 1800, '2026-07-22T14:00:00.000Z'),
  ]);

  const report = await service.getTimeSavingsReport(admin as never, {});

  assert.equal(report.totals.executions, 3);
  assert.equal(report.totals.executionsWithSavings, 2);
  assert.equal(report.totals.executionsWithoutSavings, 1);
  assert.equal(report.totals.automationsWithSavings, 1);
  assert.equal(report.totals.beneficiaries, 1);
  // O total historico de horas nao muda: execucoes zeradas somam 0.
  assert.equal(report.totals.savedSeconds, 2400);
  // Mediana so considera execucoes com ganho: (600 + 1800) / 2
  assert.equal(report.totals.medianSavedSeconds, 1200);
  assert.equal(report.totals.averageSavedSeconds, 1200);
  assert.equal(report.byRobot[0].executions, 2);
  assert.equal(report.byRobot[0].sharePct, 100);
});

test('robo so com execucoes zeradas nao aparece no ranking', async () => {
  const service = createService([execution('e1', 'maria.silva', 0, '2026-07-22T12:00:00.000Z')]);

  const report = await service.getTimeSavingsReport(admin as never, {});

  assert.equal(report.totals.executions, 1);
  assert.equal(report.totals.automationsWithSavings, 0);
  assert.equal(report.byRobot.length, 0);
  assert.equal(report.totals.medianSavedSeconds, null);
});

test('tendencia agrupa pelo dia de Fortaleza e nao pelo dia UTC', async () => {
  // 22:30 em Fortaleza do dia 22 == 01:30 UTC do dia 23
  const service = createService([execution('e1', 'maria.silva', 600, '2026-07-23T01:30:00.000Z')]);

  const report = await service.getTimeSavingsReport(admin as never, {
    from: '2026-07-22',
    to: '2026-07-23',
  });

  assert.deepEqual(
    report.series.map((bucket) => [bucket.key, bucket.savedSeconds]),
    [
      ['2026-07-22', 600],
      ['2026-07-23', 0],
    ],
  );
  assert.equal(report.totals.savedSeconds, 600);
});

test('periodo anterior alimenta o delta e a serie de comparacao', async () => {
  const service = createService(
    [
      execution('e1', 'maria.silva', 3600, '2026-07-22T15:00:00.000Z'),
      execution('e2', 'maria.silva', 1800, '2026-07-21T15:00:00.000Z'),
    ],
    { firstDataAt: new Date('2026-07-01T15:00:00.000Z') },
  );

  const report = await service.getTimeSavingsReport(admin as never, {
    from: '2026-07-22',
    to: '2026-07-22',
  });

  assert.equal(report.previousRange?.comparable, true);
  assert.equal(report.totals.savedSeconds, 3600);
  assert.equal(report.previousTotals?.savedSeconds, 1800);
  assert.equal(report.deltas?.savedSeconds?.direction, 'up');
  assert.equal(report.deltas?.savedSeconds?.pct, 100);
  assert.equal(report.series[0].previousSavedSeconds, 1800);
});

test('outlier continua no total e e sinalizado quando ha amostra suficiente', async () => {
  const normal = Array.from({ length: 25 }, (_, i) =>
    execution(`n${i}`, 'maria.silva', 600, '2026-07-22T12:00:00.000Z'),
  );
  const huge = execution('big', 'maria.silva', 600_000, '2026-07-22T12:00:00.000Z');
  const service = createService([...normal, huge]);

  const report = await service.getTimeSavingsReport(admin as never, {});

  assert.equal(report.totals.savedSeconds, 25 * 600 + 600_000);
  assert.equal(report.outliers.count, 1);
  assert.equal(report.outliers.top[0].id, 'big');
  assert.ok(report.outliers.sharePct > 90);

  const details = await service.getTimeSavingsExecutions(admin as never, { outliersOnly: true });
  assert.deepEqual(details.items.map((item) => item.id), ['big']);
});

test('amostra pequena nao gera outliers', async () => {
  const service = createService([
    execution('a', 'maria.silva', 600, '2026-07-22T12:00:00.000Z'),
    execution('b', 'maria.silva', 600_000, '2026-07-22T13:00:00.000Z'),
  ]);

  const report = await service.getTimeSavingsReport(admin as never, {});

  assert.equal(report.outliers.threshold, null);
  assert.equal(report.outliers.count, 0);
});

test('ritmo anual e null sem cobertura minima', async () => {
  const service = createService(
    [execution('e1', 'maria.silva', 3600, '2026-10-01T15:00:00.000Z')],
    { firstDataAt: new Date('2026-09-30T15:00:00.000Z') },
  );

  const report = await service.getTimeSavingsReport(admin as never, {});

  assert.equal(report.runRate, null);
  assert.equal(report.runRateUnavailableReason, 'insufficient_sample');
});

test('ritmo anual ignora o filtro de periodo e usa a janela dos ultimos dias completos', async () => {
  // 40 dias seguidos (2026-08-25..2026-10-03), 1h por dia
  const daily = Array.from({ length: 40 }, (_, i) =>
    execution(`d${i}`, 'maria.silva', 3600, new Date(Date.UTC(2026, 7, 25 + i, 15)).toISOString()),
  );
  const service = createService(daily, { firstDataAt: new Date('2026-08-25T15:00:00.000Z') });

  const report = await service.getTimeSavingsReport(admin as never, {
    from: '2026-10-01',
    to: '2026-10-05',
  });

  assert.ok(report.runRate);
  assert.equal(report.runRate?.windowFrom, '2026-08-25');
  assert.equal(report.runRate?.windowTo, '2026-10-04');
  assert.equal(report.runRate?.sampleDays, 41);
  assert.equal(report.runRate?.activeDays, 40);
  // (40h / 41 dias) * 365 ~ 356h, arredondado a 2 algarismos significativos
  assert.equal((report.runRate?.estimate ?? 0) / 3600, 360);
  assert.ok((report.runRate?.lowerBound ?? 0) <= (report.runRate?.estimate ?? 0));
  assert.ok((report.runRate?.upperBound ?? 0) >= (report.runRate?.estimate ?? 0));
  // O periodo filtrado (3 dias com dado) nao muda a estimativa
  assert.equal(report.totals.executions, 3);
});

test('qualidade dos dados: unidades assumidas e robos sem taxa', async () => {
  const hubRobot = {
    name: 'Robo hub',
    unitLabel: 'nota',
    manualSecondsPerUnit: 300,
    allowedDepartments: [] as string[],
    isExternal: false,
  };
  const hub = { ...execution('hub1', 'maria.silva', 300, '2026-07-22T12:00:00.000Z'), robot: hubRobot };
  const noRate = {
    ...execution('hub2', 'maria.silva', 0, '2026-07-22T13:00:00.000Z'),
    robot: { ...hubRobot, name: 'Robo BI', manualSecondsPerUnit: 0 },
    robotId: 'robot-2',
  };
  const service = createService([hub, noRate]);

  const report = await service.getTimeSavingsReport(admin as never, {});

  assert.equal(report.quality.completedExecutions, 2);
  assert.equal(report.quality.executionsWithoutSavings, 1);
  assert.equal(report.quality.assumedUnits.count, 1);
  assert.equal(report.quality.automationsWithoutRate.count, 1);
  assert.equal(report.quality.automationsWithoutRate.items[0].robotName, 'Robo BI');
  assert.equal(report.quality.missingUnits.pct, 100);
});

test('detalhes: pagina no servidor, oculta linhas zeradas e permite incluir', async () => {
  const service = createService([
    execution('a', 'ana', 600, '2026-07-22T12:00:00.000Z'),
    execution('b', 'bia', 0, '2026-07-22T13:00:00.000Z'),
    execution('c', 'caio', 1200, '2026-07-22T14:00:00.000Z'),
  ]);

  const onlySavings = await service.getTimeSavingsExecutions(admin as never, { pageSize: 1 });
  assert.equal(onlySavings.total, 2);
  assert.equal(onlySavings.totalPages, 2);
  assert.equal(onlySavings.items.length, 1);
  assert.equal(onlySavings.items[0].id, 'c');

  const withZero = await service.getTimeSavingsExecutions(admin as never, { includeZero: true });
  assert.equal(withZero.total, 3);

  const sorted = await service.getTimeSavingsExecutions(admin as never, { sort: 'saved', dir: 'asc' });
  assert.deepEqual(sorted.items.map((item) => item.id), ['a', 'c']);

  const searched = await service.getTimeSavingsExecutions(admin as never, { search: 'CAIO' });
  assert.deepEqual(searched.items.map((item) => item.id), ['c']);
});

test('periodo anterior anterior ao primeiro dado nao gera delta', async () => {
  const service = createService(
    [execution('e1', 'maria.silva', 3600, '2026-07-22T15:00:00.000Z')],
    // A base so comecou no meio do periodo anterior (21/07).
    { firstDataAt: new Date('2026-07-22T10:00:00.000Z') },
  );

  const report = await service.getTimeSavingsReport(admin as never, {
    from: '2026-07-22',
    to: '2026-07-22',
  });

  assert.equal(report.previousRange?.comparable, false);
  assert.equal(report.deltas, null);
  assert.equal(report.previousTotals?.savedSeconds, 0);
});
