import { useState } from 'react';
import { SEVERITY_META, nf, type Insight, type InsightSeverity, type InsightTarget } from '../../lib/robot-health';
import { HcInfo } from './kit';

// ---------- Insights: frases prontas, calculadas por regras fixas (no servidor) sobre os mesmos dados dos gráficos ----------

const PILL_LABEL: Record<InsightSeverity, [string, string]> = {
  crit: ['crítico', 'críticos'],
  warn: ['ponto de atenção', 'pontos de atenção'],
  info: ['informação', 'informações'],
  good: ['boa notícia', 'boas notícias'],
};

const GROUPS: Array<{ title: string; fit: (i: Insight) => boolean; cap: number }> = [
  { title: 'Atenção agora', fit: (i) => !i.kind && (i.sev === 'crit' || i.sev === 'warn'), cap: 8 },
  { title: 'Robôs que pedem atenção', fit: (i) => i.kind === 'robo', cap: 6 },
  { title: 'Para saber', fit: (i) => !i.kind && i.sev === 'info', cap: 6 },
  { title: 'Boas notícias', fit: (i) => !i.kind && i.sev === 'good', cap: 5 },
];

/** Quantos insights pedem atenção (críticos e pontos de atenção): é o número do selo da aba "Insights". */
export const attentionCount = (list: Insight[]) => list.filter((i) => i.sev === 'crit' || i.sev === 'warn').length;

function InsightCard({ i, onGo }: { i: Insight; onGo: (t: InsightTarget) => void }) {
  const meta = SEVERITY_META[i.sev];
  return (
    <article className="hc-ins" data-sev={i.sev} aria-label={`${meta.label}: ${i.title}`}>
      <div className="ico" aria-hidden="true">{meta.icon}</div>
      <div className="bd">
        <div className="hd">
          <h4>{i.title}</h4>
          <HcInfo label="Como foi calculado" text={i.why} />
        </div>
        <p>{i.text}</p>
        {i.chips?.length ? (
          <div className="chips">
            {i.chipsLabel ? <span className="lb">{i.chipsLabel}</span> : null}
            {i.chips.map((c) => (
              <span key={`${c.t}-${c.n}`} className="chip">
                {c.t}
                <b> · {c.n}</b>
              </span>
            ))}
          </div>
        ) : null}
        {i.facts?.length ? (
          <ul className="facts">
            {i.facts.map((f) => (
              <li key={f.t} data-sev={f.sev}>{f.t}</li>
            ))}
          </ul>
        ) : null}
        {i.acts?.length ? (
          <div className="acts">
            {i.acts.map((a) => (
              <button key={a.l} type="button" className="go" onClick={() => onGo(a.go)}>
                {a.l} →
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function InsightsView({ insights, hasExecutions, onGo }: { insights: Insight[]; hasExecutions: boolean; onGo: (t: InsightTarget) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!hasExecutions) return <p className="hc-empty">Nenhuma execução neste período e neste filtro, então não há o que analisar.</p>;
  const count: Record<InsightSeverity, number> = { crit: 0, warn: 0, info: 0, good: 0 };
  insights.forEach((i) => (count[i.sev] += 1));
  const toggle = (title: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  return (
    <div className="hc-insights">
      <p className="hc-lead">
        O que merece atenção, em frases prontas. São calculados por regras fixas sobre os mesmos dados dos gráficos e seguem o período e o filtro de origem escolhidos (os de capacidade e de agendamentos ignoram o filtro de origem, como os gráficos deles). O “i” de cada insight mostra a conta.
      </p>
      <div className="hc-ins-sum">
        {(['crit', 'warn', 'info', 'good'] as const).filter((k) => count[k]).map((k) => (
          <span key={k} className="pill" data-sev={k}>
            <i aria-hidden="true">{SEVERITY_META[k].icon}</i>
            {nf(count[k])} {PILL_LABEL[k][count[k] === 1 ? 0 : 1]}
          </span>
        ))}
      </div>
      {!count.crit && !count.warn ? <p className="hc-empty">Nenhum ponto de atenção neste período e neste filtro.</p> : null}
      {GROUPS.map((g) => {
        const items = insights.filter(g.fit);
        if (!items.length) return null;
        const expanded = open.has(g.title);
        return (
          <section key={g.title}>
            <h3 className="hc-gt">{g.title} ({items.length})</h3>
            <div className="hc-ins-list">
              {(expanded ? items : items.slice(0, g.cap)).map((i) => (
                <InsightCard key={i.id} i={i} onGo={onGo} />
              ))}
            </div>
            {items.length > g.cap ? (
              <div className="hc-more">
                <button type="button" onClick={() => toggle(g.title)}>
                  {expanded ? 'Mostrar menos' : `Mostrar todos (${items.length})`}
                </button>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
