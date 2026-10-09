import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatFte, formatNumber } from '../../lib/time-savings-metrics';
import type { TimeSavingsDelta, TimeSavingsReport } from '../../lib/types';
import { cn, formatSecondsToHuman } from '../../lib/utils';
import { InfoTip } from './info-tip';

// Horas e minutos com a unidade em corpo menor: o número é o que se lê.
function DurationValue({ seconds }: { seconds: number }) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const unit = (text: string) => (
    <span className="ml-0.5 mr-1.5 text-base font-medium text-slate-400 dark:text-zinc-500">{text}</span>
  );

  if (hours > 0) {
    return (
      <>
        {hours.toLocaleString('pt-BR')}
        {unit('h')}
        {minutes > 0 ? (
          <>
            {minutes}
            {unit('min')}
          </>
        ) : null}
      </>
    );
  }
  if (minutes > 0 || total === 0) {
    return (
      <>
        {minutes}
        {unit('min')}
      </>
    );
  }
  return (
    <>
      {total}
      {unit('s')}
    </>
  );
}

function DeltaLine({
  delta,
  comparison,
}: {
  delta: TimeSavingsDelta | null;
  comparison: 'none' | 'incomplete' | 'ok';
}) {
  const base = 'text-sm leading-5';
  if (comparison === 'none') {
    return <p className={cn(base, 'text-slate-500 dark:text-zinc-400')}>Sem período anterior para comparar</p>;
  }
  if (comparison === 'incomplete') {
    return <p className={cn(base, 'text-slate-500 dark:text-zinc-400')}>Período anterior sem histórico completo</p>;
  }
  if (!delta) {
    return <p className={cn(base, 'text-slate-500 dark:text-zinc-400')}>= período anterior</p>;
  }
  if (delta.direction === 'new') {
    return <p className={cn(base, 'text-slate-500 dark:text-zinc-400')}>Sem dados no período anterior</p>;
  }
  if (delta.direction === 'flat') {
    return <p className={cn(base, 'text-slate-500 dark:text-zinc-400')}>= período anterior</p>;
  }
  const up = delta.direction === 'up';
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <p className={cn(base, 'flex items-center gap-1 text-slate-500 dark:text-zinc-400')}>
      <span
        className={cn(
          'inline-flex items-center gap-0.5 font-semibold',
          up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {formatNumber(Math.abs(delta.pct ?? 0), 0)}%
      </span>
      vs. período anterior
    </p>
  );
}

function Kpi({
  label,
  tip,
  value,
  children,
}: {
  label: string;
  tip: ReactNode;
  value: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-sm font-medium text-slate-500 dark:text-zinc-400">
        {label}
        <InfoTip label={`Como ${label.toLocaleLowerCase('pt-BR')} é calculado`}>{tip}</InfoTip>
      </div>
      <p className="mt-2.5 whitespace-nowrap text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-slate-950 dark:text-white">
        {value}
      </p>
      <div className="mt-2.5 space-y-1">{children}</div>
    </div>
  );
}

export function KpiRow({ report }: { report: TimeSavingsReport }) {
  const { totals, range, config } = report;
  const comparison = report.previousRange === null ? 'none' : report.previousRange.comparable ? 'ok' : 'incomplete';
  // Linha principal do subtítulo (mesma altura em todos os KPIs) e linha de apoio.
  const subtle = 'text-sm leading-5 text-slate-500 dark:text-zinc-400';
  const support = 'text-xs leading-5 text-slate-400 dark:text-zinc-500';

  return (
    <section aria-label="Indicadores principais" className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label="Horas economizadas"
        tip="Esforço manual estimado evitado pelas automações no período. Não é o tempo líquido de processamento: é quanto levaria fazer o mesmo trabalho manualmente."
        value={<DurationValue seconds={totals.savedSeconds} />}
      >
        <DeltaLine delta={report.deltas?.savedSeconds ?? null} comparison={comparison} />
      </Kpi>

      <Kpi
        label="Capacidade liberada"
        tip={
          <>
            <strong className="font-semibold">Horas economizadas ÷ (dias úteis × jornada)</strong>
            <br />
            {range && totals.capacityFte !== null ? (
              <>
                {formatSecondsToHuman(totals.savedSeconds)} ÷ ({range.businessDays} dias úteis × {config.workdayHours}h) ={' '}
                {formatFte(totals.capacityFte)} FTE.
                <br />
              </>
            ) : null}
            Dias úteis: segunda a sexta, sem descontar feriados. Jornada considerada: {config.workdayHours}h por dia.
          </>
        }
        value={
          <>
            {formatFte(totals.capacityFte)}
            <span className="ml-1.5 text-base font-medium text-slate-400 dark:text-zinc-500">FTE</span>
          </>
        }
      >
        <p className={subtle}>Capacidade equivalente no período</p>
      </Kpi>

      <Kpi
        label="Execuções com ganho"
        tip="Execuções concluídas cujo ganho estimado é maior que zero. Execuções sem estimativa de ganho não entram neste número, mas o total concluído é mostrado ao lado."
        value={totals.executionsWithSavings.toLocaleString('pt-BR')}
      >
        <p className={subtle}>de {totals.executions.toLocaleString('pt-BR')} execuções concluídas</p>
        <p className={support}>
          {totals.medianSavedSeconds !== null
            ? `Mediana: ${formatSecondsToHuman(totals.medianSavedSeconds)} por execução com ganho`
            : 'Mediana: sem execuções com ganho'}
        </p>
      </Kpi>

      <Kpi
        label="Pessoas beneficiadas"
        tip="Pessoas distintas que receberam crédito por alguma economia no período. Em agendamentos com crédito para um departamento, o ganho vai para o departamento e não conta como pessoa."
        value={totals.beneficiaries.toLocaleString('pt-BR')}
      >
        <p className={subtle}>
          {totals.automationsWithSavings.toLocaleString('pt-BR')}{' '}
          {totals.automationsWithSavings === 1 ? 'automação com ganho' : 'automações com ganho'}
        </p>
      </Kpi>
    </section>
  );
}
