import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ORIGIN_LABEL, formatNumber, formatPct } from '../../lib/time-savings-metrics';
import type { TimeSavingsReport } from '../../lib/types';
import { cn, formatSecondsToHuman } from '../../lib/utils';
import { InfoTip } from './info-tip';

const NAME_LIMIT = 3;

function Stat({
  label,
  tip,
  value,
  detail,
}: {
  label: string;
  tip: ReactNode;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-sm text-slate-500 dark:text-zinc-400">
        <span className="truncate">{label}</span>
        <InfoTip label={`Sobre: ${label}`} className="shrink-0">
          {tip}
        </InfoTip>
      </dt>
      <dd className="mt-1 text-xl font-semibold leading-tight tabular-nums text-slate-900 dark:text-zinc-100">{value}</dd>
      <p className="mt-0.5 text-xs text-slate-400 dark:text-zinc-500">{detail}</p>
    </div>
  );
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function pctOfCompleted(count: number, completed: number) {
  return completed > 0 ? formatPct((count / completed) * 100, 0) : '0%';
}

// Resumo em uma linha do que merece atenção, visível mesmo com o bloco fechado.
function attentionSummary(report: TimeSavingsReport) {
  const { quality, outliers } = report;
  const withoutRate = quality.automationsWithoutRate.count;
  const flags: string[] = [];
  if (quality.executionsWithoutSavings > 0) flags.push(`${quality.executionsWithoutSavings} sem estimativa`);
  if (withoutRate > 0) {
    flags.push(`${withoutRate} ${plural(withoutRate, 'automação', 'automações')} sem tempo configurado`);
  }
  if (outliers.count > 0) flags.push(`${outliers.count} ${plural(outliers.count, 'outlier', 'outliers')}`);
  return flags.length > 0 ? flags.join(' · ') : 'Nenhum ponto de atenção';
}

export function DataQuality({ report }: { report: TimeSavingsReport }) {
  // Recolhida por padrão: é conferência, não leitura principal.
  const [open, setOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const panelId = useId();
  const technicalId = useId();
  const { quality, outliers } = report;
  const withoutRate = quality.automationsWithoutRate;
  const topOutlier = outliers.top[0];
  const shownNames = withoutRate.items.slice(0, NAME_LIMIT).map((item) => item.robotName);
  const hiddenNames = withoutRate.count - shownNames.length;

  return (
    <section aria-labelledby="quality-title" className="border-t border-slate-200 pt-6 dark:border-[#27272a]">
      <h2 id="quality-title" className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
        >
          Cobertura e qualidade dos dados
          <span className="text-sm font-normal text-slate-500 dark:text-zinc-400">{attentionSummary(report)}</span>
          <ChevronDown
            className={cn('ml-auto h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </h2>

      {open ? (
        <div id={panelId} className="mt-5 space-y-8">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-5 xl:grid-cols-4">
            <Stat
              label="Com ganho"
              tip="Execuções concluídas cujo ganho estimado é maior que zero."
              value={formatNumber(quality.executionsWithSavings, 0)}
              detail={`${pctOfCompleted(quality.executionsWithSavings, quality.completedExecutions)} das execuções`}
            />
            <Stat
              label="Sem estimativa de ganho"
              tip="Execuções concluídas com ganho zero, em geral porque a automação não tem tempo manual configurado. Contam como execução, mas não geram tempo economizado."
              value={formatNumber(quality.executionsWithoutSavings, 0)}
              detail={`${pctOfCompleted(quality.executionsWithoutSavings, quality.completedExecutions)} das execuções`}
            />
            <Stat
              label="Outliers"
              tip={
                outliers.threshold !== null
                  ? `Execuções com ganho acima de ${formatSecondsToHuman(outliers.threshold)} (P${outliers.percentile} do período). Continuam somadas no total.`
                  : `A regra só vale com ${outliers.minSample} ou mais execuções com ganho no período.`
              }
              value={formatNumber(outliers.count, 0)}
              detail={outliers.count > 0 ? `${formatPct(outliers.sharePct, 0)} do tempo` : 'nenhum'}
            />
            <Stat
              label="Sem quantidade medida"
              tip="Execuções concluídas em que o robô não informou quantas unidades processou."
              value={formatPct(quality.missingUnits.pct, 0)}
              detail={`${formatNumber(quality.missingUnits.count, 0)} de ${formatNumber(quality.completedExecutions, 0)}`}
            />
          </dl>

          <div className="grid grid-cols-1 gap-x-14 gap-y-8 xl:grid-cols-2">
            <div>
              <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold text-slate-900 dark:text-zinc-100">
                Origem do ganho
                <InfoTip label="Sobre a origem do ganho">
                  Agrupado pelo tipo de robô, e não pela confiabilidade do número. Em integrações externas, o tempo
                  economizado é informado pelo próprio sistema de origem.
                </InfoTip>
              </h3>
              <ul className="space-y-2">
                {quality.byOrigin.map((row) => (
                  <li key={row.origin} className="flex items-baseline justify-between gap-4 text-sm">
                    <span className="text-slate-700 dark:text-zinc-300">{ORIGIN_LABEL[row.origin]}</span>
                    <span className="flex items-baseline gap-3 tabular-nums">
                      <span className="text-xs text-slate-400 dark:text-zinc-500">
                        {formatSecondsToHuman(row.savedSeconds)}
                      </span>
                      <span className="w-14 text-right font-medium text-slate-900 dark:text-zinc-100">
                        {formatPct(row.sharePct)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold text-slate-900 dark:text-zinc-100">
                Revisar
                <InfoTip label="Sobre o que revisar">
                  Valores muito acima do padrão e automações sem tempo manual configurado. Nada foi removido do total.
                  Para ver todos os outliers, use “Só outliers” na aba Execuções.
                </InfoTip>
              </h3>
              {outliers.count === 0 && withoutRate.count === 0 ? (
                <p className="text-sm text-slate-500 dark:text-zinc-400">Nada para revisar no período.</p>
              ) : (
                <ul className="space-y-3.5">
                  {outliers.count > 0 ? (
                    <li>
                      <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
                        {outliers.count} {plural(outliers.count, 'outlier', 'outliers')}
                      </p>
                      {topOutlier ? (
                        <p className="mt-0.5 truncate text-xs text-slate-400 dark:text-zinc-500">
                          {outliers.count > 1 ? 'Maior: ' : ''}
                          {topOutlier.robotName} · {formatSecondsToHuman(topOutlier.savedSeconds)} ·{' '}
                          {formatPct(topOutlier.sharePct, 0)} do período
                        </p>
                      ) : null}
                    </li>
                  ) : null}
                  {withoutRate.count > 0 ? (
                    <li>
                      <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
                        {withoutRate.count}{' '}
                        {plural(withoutRate.count, 'automação sem tempo configurado', 'automações sem tempo configurado')}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-400 dark:text-zinc-500">
                        {shownNames.join(', ')}
                        {hiddenNames > 0 ? ` e mais ${hiddenNames}` : ''}
                      </p>
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          </div>

          <div>
            <button
              type="button"
              aria-expanded={technicalOpen}
              aria-controls={technicalId}
              onClick={() => setTechnicalOpen((prev) => !prev)}
              className="flex items-center gap-1.5 rounded-md text-sm font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Detalhes técnicos
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', technicalOpen && 'rotate-180')}
                aria-hidden="true"
              />
            </button>

            {technicalOpen ? (
              <dl id={technicalId} className="mt-4 space-y-4 text-sm">
                <div>
                  <dt className="font-medium text-slate-700 dark:text-zinc-300">
                    Ganho calculado com quantidade estimada{' '}
                    <span className="font-normal text-slate-500 dark:text-zinc-400">
                      {quality.assumedUnits.count > 0
                        ? `· ${formatSecondsToHuman(quality.assumedUnits.savedSeconds)} · ${formatNumber(quality.assumedUnits.count, 0)} exec. · ${formatPct(quality.assumedUnits.sharePct)} do tempo`
                        : '· nenhuma'}
                    </span>
                  </dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-slate-400 dark:text-zinc-500">
                    Estimativa. Vale para robôs do hub com ganho maior que zero e sem quantidade medida: o cálculo
                    assumiu 1 unidade por execução.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-700 dark:text-zinc-300">
                    Automações sem tempo configurado{' '}
                    <span className="font-normal text-slate-500 dark:text-zinc-400">· {formatNumber(withoutRate.count, 0)}</span>
                  </dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-slate-400 dark:text-zinc-500">
                    {withoutRate.items.length > 0
                      ? `${withoutRate.items.map((item) => item.robotName).join(', ')}${
                          withoutRate.count > withoutRate.items.length
                            ? ` e mais ${withoutRate.count - withoutRate.items.length}`
                            : ''
                        }. `
                      : ''}
                    Sem “tempo manual por unidade” cadastrado: as execuções delas não geram ganho.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-700 dark:text-zinc-300">Regra de outlier</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-slate-400 dark:text-zinc-500">
                    {outliers.threshold !== null
                      ? `Execuções com ganho acima de ${formatSecondsToHuman(outliers.threshold)} (P${outliers.percentile} do período, com mínimo de ${outliers.minSample} execuções). Continuam no total.`
                      : `A regra só vale com ${outliers.minSample} ou mais execuções com ganho no período.`}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-700 dark:text-zinc-300">Execuções sem quantidade medida</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-slate-400 dark:text-zinc-500">
                    {formatNumber(quality.missingUnits.count, 0)} de {formatNumber(quality.completedExecutions, 0)}:
                    o robô não informou quantas unidades processou.
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
