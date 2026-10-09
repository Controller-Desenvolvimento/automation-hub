import type { Insight } from '../../lib/time-savings-metrics';
import { cn } from '../../lib/utils';

const DOT: Record<Insight['tone'], string> = {
  neutral: 'bg-slate-400 dark:bg-zinc-500',
  positive: 'bg-emerald-500',
  warning: 'bg-amber-500',
};

export function InsightsCard({ insights }: { insights: Insight[] }) {
  return (
    <section aria-labelledby="insights-title" className="space-y-4">
      <h2 id="insights-title" className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">
        Insights do período
      </h2>

      {insights.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-zinc-400">
          Sem execuções com ganho no período: não há o que destacar.
        </p>
      ) : (
        <ul className="space-y-4">
          {insights.map((insight) => (
            <li key={insight.id} className="flex gap-3">
              <span
                className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', DOT[insight.tone])}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm leading-relaxed text-slate-700 dark:text-zinc-300">
                  {insight.segments.map((segment, index) =>
                    segment.strong ? (
                      <strong key={index} className="font-semibold text-slate-950 dark:text-white">
                        {segment.text}
                      </strong>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </p>
                {insight.note ? (
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-400 dark:text-zinc-500">{insight.note}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
