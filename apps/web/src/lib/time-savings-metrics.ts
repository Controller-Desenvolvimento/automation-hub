import type {
  TimeSavingsDelta,
  TimeSavingsGranularity,
  TimeSavingsOrigin,
  TimeSavingsReport,
} from './types';

// Este módulo só formata, trabalha com datas de filtro e monta textos. Toda
// regra de negócio (ganho, mediana, outliers, ritmo anual, FTE, buckets) vem
// pronta da API (apps/api/src/reports).

const REPORT_TIME_ZONE = 'America/Fortaleza';
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Datas dos filtros (strings YYYY-MM-DD no fuso do relatório) ─────────────

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function todayIso(): string {
  return dayFormatter.format(new Date());
}

function parseIso(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(value: string, days: number): string {
  return new Date(parseIso(value) + days * DAY_MS).toISOString().slice(0, 10);
}

export function formatDay(value: string): string {
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

export function formatDayShort(value: string): string {
  return `${value.slice(8, 10)}/${value.slice(5, 7)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: REPORT_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// Data/hora de um instante ISO no fuso do relatório (não no do navegador).
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso)).replace(',', '');
}

export function formatDateOnly(iso: string): string {
  return formatDateTime(iso).slice(0, 10);
}

export type PeriodPreset = '7d' | 'month' | '90d' | 'year';

export const PERIOD_PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: '7d', label: '7 dias' },
  { id: 'month', label: 'Este mês' },
  { id: '90d', label: '90 dias' },
  { id: 'year', label: 'Este ano' },
];

export function presetRange(preset: PeriodPreset, today = todayIso()): { from: string; to: string } {
  switch (preset) {
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

export function matchPreset(from: string, to: string, today = todayIso()): PeriodPreset | null {
  for (const preset of PERIOD_PRESETS) {
    const range = presetRange(preset.id, today);
    if (range.from === from && range.to === to) return preset.id;
  }
  return null;
}

// ── Formatação ──────────────────────────────────────────────────────────────

export function formatNumber(value: number, digits = 1): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPct(value: number, digits = 1): string {
  return `${formatNumber(value, digits)}%`;
}

export function formatFte(fte: number | null): string {
  if (fte === null) return '—';
  if (fte > 0 && fte < 0.05) return '< 0,1';
  return formatNumber(fte, 1);
}

export function formatHoursAmount(seconds: number, digits = 0): string {
  return `${formatNumber(seconds / 3600, digits)} h`;
}

export const ORIGIN_LABEL: Record<TimeSavingsOrigin, string> = {
  hub: 'Robô do hub',
  external: 'Integração externa',
  external_metric: 'Métrica externa (legado)',
};

export const UNKNOWN_DEPARTMENT_LABEL = 'Sem departamento definido';

// ── Insights (determinísticos, a partir dos números já normalizados) ────────

export type InsightSegment = { text: string; strong?: boolean };
export type Insight = {
  id: string;
  tone: 'neutral' | 'positive' | 'warning';
  segments: InsightSegment[];
  note?: string;
};

const s = (text: string): InsightSegment => ({ text });
const b = (text: string): InsightSegment => ({ text, strong: true });

function pctOf(delta: TimeSavingsDelta | null): number | null {
  return delta && delta.pct !== null ? Math.abs(delta.pct) : null;
}

function comparisonInsight(report: TimeSavingsReport): Insight | null {
  const saved = report.deltas?.savedSeconds ?? null;
  const executions = report.deltas?.executionsWithSavings ?? null;
  if (!saved || saved.direction === 'new') return null;

  const savedPct = pctOf(saved);
  const execPct = pctOf(executions);

  // Eficiência: execuções e tempo caminham em sentidos opostos.
  if (
    executions &&
    savedPct !== null &&
    execPct !== null &&
    executions.direction === 'down' &&
    saved.direction === 'up'
  ) {
    return {
      id: 'efficiency',
      tone: 'positive',
      segments: [
        s('O número de execuções com ganho caiu '),
        b(formatPct(execPct, 0)),
        s(', mas o tempo economizado aumentou '),
        b(formatPct(savedPct, 0)),
        s('.'),
      ],
    };
  }
  if (
    executions &&
    savedPct !== null &&
    execPct !== null &&
    executions.direction === 'up' &&
    saved.direction === 'down'
  ) {
    return {
      id: 'efficiency',
      tone: 'neutral',
      segments: [
        s('As execuções com ganho aumentaram '),
        b(formatPct(execPct, 0)),
        s(', mas o tempo economizado caiu '),
        b(formatPct(savedPct, 0)),
        s('.'),
      ],
    };
  }

  if (saved.direction === 'flat') {
    return {
      id: 'comparison',
      tone: 'neutral',
      segments: [s('O tempo economizado ficou estável em relação ao período anterior.')],
    };
  }

  return {
    id: 'comparison',
    tone: saved.direction === 'up' ? 'positive' : 'neutral',
    segments: [
      s('O tempo economizado '),
      s(saved.direction === 'up' ? 'aumentou ' : 'caiu '),
      b(formatPct(savedPct ?? 0, 0)),
      s(' em relação ao período anterior.'),
    ],
  };
}

export function buildInsights(report: TimeSavingsReport): Insight[] {
  if (report.totals.savedSeconds <= 0) return [];

  const candidates: Array<Insight | null> = [];

  candidates.push(comparisonInsight(report));

  const top = report.byRobot[0];
  if (top) {
    candidates.push({
      id: 'top-automation',
      tone: 'neutral',
      segments: [b(top.robotName), s(' respondeu por '), b(formatPct(top.sharePct)), s(' do tempo economizado.')],
    });
  }

  if (report.outliers.count > 0) {
    const first = report.outliers.top[0];
    candidates.push({
      id: 'outlier',
      tone: 'warning',
      segments:
        report.outliers.count === 1
          ? [
              s('Uma execução'),
              ...(first ? [s(' ('), b(first.robotName), s(')')] : []),
              s(' representa '),
              b(formatPct(report.outliers.sharePct)),
              s(' do ganho do período.'),
            ]
          : [
              b(`${report.outliers.count} execuções`),
              s(` acima do limite P${report.outliers.percentile} somam `),
              b(formatPct(report.outliers.sharePct)),
              s(' do ganho do período.'),
            ],
      note: 'Valores extremos continuam incluídos no total.',
    });
  } else if (report.concentration.byRobot.count >= 4) {
    candidates.push({
      id: 'concentration',
      tone: 'neutral',
      segments: [
        s('As 3 principais automações representam '),
        b(formatPct(report.concentration.byRobot.top3Pct, 0)),
        s(' do ganho.'),
      ],
    });
  }

  const insights = candidates.filter((item): item is Insight => item !== null).slice(0, 3);

  if (report.runRate) {
    const { lowerBound, upperBound, estimate, sampleDays } = report.runRate;
    insights.push({
      id: 'run-rate',
      tone: 'neutral',
      segments: [
        s('Ritmo atual estimado entre '),
        b(formatNumber(lowerBound / 3600, 0)),
        s(' e '),
        b(formatNumber(upperBound / 3600, 0)),
        s(' horas/ano.'),
      ],
      note: `Estimativa central de ${formatHoursAmount(estimate)} · base: últimos ${sampleDays} dias.`,
    });
  } else {
    insights.push({
      id: 'run-rate',
      tone: 'neutral',
      segments: [s('Dados insuficientes para estimativa anual confiável.')],
      note: `Exige pelo menos ${report.config.runRateMinSampleDays} dias de histórico com atividade recorrente.`,
    });
  }

  return insights;
}

// ── Exportação (resumo) ─────────────────────────────────────────────────────

function csvCell(value: string | number): string {
  let text = typeof value === 'number' ? formatNumber(value, 2) : value;
  // Evita que o Excel interprete texto como fórmula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells: Array<string | number>): string {
  return cells.map(csvCell).join(';');
}

const GRANULARITY_LABEL: Record<TimeSavingsGranularity, string> = {
  day: 'dia',
  week: 'semana',
  month: 'mês',
};

export function buildSummaryCsv(params: {
  report: TimeSavingsReport;
  departmentLabel: (slug: string) => string;
}): string {
  const { report, departmentLabel } = params;
  const hours = (seconds: number) => seconds / 3600;
  const lines: string[] = [];

  lines.push(csvRow(['Relatório de tempo ganho com automações']));
  lines.push(
    csvRow([
      'Período',
      report.range ? `${report.range.from} a ${report.range.to}` : 'Sem dados no período',
    ]),
  );
  lines.push(csvRow(['Fuso horário', report.timezone]));
  lines.push(csvRow(['Jornada considerada (horas/dia)', report.config.workdayHours]));
  lines.push(csvRow(['Dias úteis no período (seg–sex, sem feriados)', report.range?.businessDays ?? 0]));
  lines.push(csvRow(['Observação', 'Estimativa do esforço manual evitado; não é tempo líquido de processamento.']));
  lines.push('');

  lines.push(csvRow(['Resumo']));
  lines.push(csvRow(['Horas economizadas', hours(report.totals.savedSeconds)]));
  lines.push(csvRow(['Capacidade liberada (FTE)', report.totals.capacityFte ?? 0]));
  lines.push(csvRow(['Execuções com ganho', report.totals.executionsWithSavings]));
  lines.push(csvRow(['Execuções concluídas', report.totals.executions]));
  lines.push(csvRow(['Mediana por execução com ganho (min)', (report.totals.medianSavedSeconds ?? 0) / 60]));
  lines.push(csvRow(['Média por execução com ganho (min)', (report.totals.averageSavedSeconds ?? 0) / 60]));
  lines.push(csvRow(['Pessoas beneficiadas', report.totals.beneficiaries]));
  lines.push(csvRow(['Automações com ganho', report.totals.automationsWithSavings]));
  lines.push(csvRow(['Itens processados (unidades de naturezas diferentes)', report.totals.unitsProcessed]));
  lines.push(csvRow(['Outliers (acima do limite)', report.outliers.count]));
  if (report.runRate) {
    lines.push(csvRow(['Ritmo anual estimado (h) — mínimo', hours(report.runRate.lowerBound)]));
    lines.push(csvRow(['Ritmo anual estimado (h) — central', hours(report.runRate.estimate)]));
    lines.push(csvRow(['Ritmo anual estimado (h) — máximo', hours(report.runRate.upperBound)]));
    lines.push(csvRow(['Ritmo anual — base (dias)', report.runRate.sampleDays]));
  } else {
    lines.push(csvRow(['Ritmo anual estimado', 'Dados insuficientes']));
  }
  lines.push('');

  lines.push(csvRow(['Por automação', 'Execuções com ganho', 'Horas economizadas', '% do total']));
  for (const r of report.byRobot) lines.push(csvRow([r.robotName, r.executions, hours(r.savedSeconds), r.sharePct]));
  lines.push('');

  lines.push(csvRow(['Por pessoa', 'Execuções com ganho', 'Horas economizadas', '% do total']));
  for (const u of report.byUser) lines.push(csvRow([u.userName, u.executions, hours(u.savedSeconds), u.sharePct]));
  lines.push('');

  lines.push(csvRow(['Por departamento', 'Execuções com ganho', 'Horas economizadas', '% do total']));
  for (const d of report.byDepartment) {
    lines.push(csvRow([departmentLabel(d.department), d.executions, hours(d.savedSeconds), d.sharePct]));
  }
  lines.push('');

  lines.push(csvRow([`Por ${GRANULARITY_LABEL[report.granularity]}`, 'Execuções com ganho', 'Horas economizadas']));
  for (const t of report.series) lines.push(csvRow([t.from === t.to ? t.from : `${t.from} a ${t.to}`, t.executions, hours(t.savedSeconds)]));

  // BOM + ; como separador: o Excel pt-BR abre direto com acentos e colunas certas.
  return `﻿${lines.join('\r\n')}\r\n`;
}
