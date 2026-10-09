import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoGranularity,
  buildBuckets,
  computeRunRate,
  deltaBetween,
  median,
  outlierThreshold,
  percentile,
  roundSecondsAsHours,
  roundSignificant,
  toReportDay,
} from '../src/reports/time-savings-metrics';

const runRateConfig = { runRateWindowDays: 90, runRateMinSampleDays: 28, runRateMinActiveDays: 10 };
const outlierConfig = { outlierPercentile: 99, outlierMinSample: 20, outlierMinMultipleOfMedian: 5 };

function dayList(startMonthIndex: number, startDay: number, count: number) {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, startMonthIndex, startDay + i)).toISOString().slice(0, 10),
  );
}

test('toReportDay usa o fuso de Fortaleza (UTC-3)', () => {
  assert.equal(toReportDay(new Date('2026-07-23T01:30:00.000Z')), '2026-07-22');
  assert.equal(toReportDay(new Date('2026-07-22T03:00:00.000Z')), '2026-07-22');
  assert.equal(toReportDay(new Date('2026-07-22T02:59:59.999Z')), '2026-07-21');
});

test('mediana e percentil', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 100), 50);
});

test('limite de outlier exige amostra minima e multiplo da mediana', () => {
  assert.equal(outlierThreshold([1, 2, 3], outlierConfig), null);
  const values = [...Array.from({ length: 99 }, () => 600), 600_000];
  const threshold = outlierThreshold(values, outlierConfig);
  assert.ok(threshold !== null && threshold >= 3000);
  assert.ok(600_000 > (threshold as number));
  assert.ok(!(600 > (threshold as number)));
});

test('deltaBetween', () => {
  assert.equal(deltaBetween(10, null), null);
  assert.deepEqual(deltaBetween(5, 0), { previous: 0, pct: null, direction: 'new' });
  assert.equal(deltaBetween(0, 0), null);
  assert.equal(deltaBetween(150, 100)?.pct, 50);
  assert.equal(deltaBetween(50, 100)?.direction, 'down');
  assert.equal(deltaBetween(100.1, 100)?.direction, 'flat');
});

test('roundSignificant evita falsa precisao', () => {
  assert.equal(roundSignificant(6243), 6200);
  assert.equal(roundSignificant(12_876_000), 13_000_000);
  assert.equal(roundSignificant(0), 0);
});

test('granularidade automatica pelo tamanho do periodo', () => {
  assert.equal(autoGranularity({ from: '2026-10-01', to: '2026-10-05' }), 'day');
  assert.equal(autoGranularity({ from: '2026-07-07', to: '2026-10-04' }), 'week');
  assert.equal(autoGranularity({ from: '2026-01-01', to: '2026-10-05' }), 'month');
});

test('buckets semanais comecam na segunda e alinham o periodo anterior', () => {
  const range = { from: '2026-10-05', to: '2026-10-18' };
  const previousRange = { from: '2026-09-21', to: '2026-10-04' };
  const buckets = buildBuckets(
    range,
    'week',
    [{ day: '2026-10-06', savedSeconds: 100, executions: 1 }],
    { range: previousRange, points: [{ day: '2026-09-22', savedSeconds: 40, executions: 2 }] },
  );
  assert.deepEqual(
    buckets.map((b) => [b.key, b.savedSeconds, b.previousSavedSeconds]),
    [
      ['2026-10-05', 100, 40],
      ['2026-10-12', 0, 0],
    ],
  );
});

test('ritmo anual: sem dados e amostra insuficiente retornam null com motivo', () => {
  const none = computeRunRate({
    today: '2026-10-05',
    firstDataDay: null,
    entries: [],
    outlierCap: null,
    config: runRateConfig,
  });
  assert.deepEqual(none, { runRate: null, reason: 'no_data' });

  const short = computeRunRate({
    today: '2026-10-05',
    firstDataDay: '2026-10-01',
    entries: [{ day: '2026-10-02', savedSeconds: 3600 }],
    outlierCap: null,
    config: runRateConfig,
  });
  assert.equal(short.runRate, null);
  assert.equal(short.reason, 'insufficient_sample');
});

test('ritmo anual: ritmo constante gera faixa estreita e metodo documentado', () => {
  const entries = dayList(6, 7, 90).map((day) => ({ day, savedSeconds: 3600 }));
  const result = computeRunRate({
    today: '2026-10-05',
    firstDataDay: '2026-01-01',
    entries,
    outlierCap: null,
    config: runRateConfig,
  });
  assert.ok(result.runRate);
  assert.equal(result.runRate?.sampleDays, 90);
  assert.equal(result.runRate?.windowTo, '2026-10-04');
  assert.equal(result.runRate?.estimate, roundSecondsAsHours(3600 * 365));
  assert.equal(result.runRate?.lowerBound, result.runRate?.upperBound);
  assert.equal(result.runRate?.method, 'trailing-window-daily-mean-x365');
});

test('ritmo anual: outlier e limitado ao teto para nao ser extrapolado', () => {
  const entries = [
    ...dayList(8, 1, 30).map((day) => ({ day, savedSeconds: 3600 })),
    { day: '2026-09-15', savedSeconds: 3_600_000 },
  ];
  const base = { today: '2026-10-05', firstDataDay: '2026-09-01', entries, config: runRateConfig };
  const capped = computeRunRate({ ...base, outlierCap: 7200 });
  const uncapped = computeRunRate({ ...base, outlierCap: null });
  assert.ok((capped.runRate?.estimate ?? 0) < (uncapped.runRate?.estimate ?? 0) / 10);
});
