import { useMemo, useState, type KeyboardEvent } from 'react';
import { GRANULARITY_LABELS, bucketLabel, bucketTitle, type HeatCell, type Heatmap } from '../../lib/robot-health';
import { InfoTip } from '../time-savings/info-tip';

const CELL = 16;
const GAP = 2;
const LABEL_W = 190;
const CRITICAL_RATE = 0.4;

type State = 'ok' | 'some' | 'many' | 'out' | 'none';

/** Estado de uma célula: o mesmo corte da situação do robô (40% de erro ou mais = muitos erros). */
export function cellState(cell: HeatCell): State {
  const [ok, err, hub, canceled] = cell;
  const concluded = ok + err;
  if (concluded > 0) {
    if (err === 0) return 'ok';
    return err / concluded >= CRITICAL_RATE ? 'many' : 'some';
  }
  return hub + canceled > 0 ? 'out' : 'none';
}

const STATE_STYLE: Record<State, { bg: string; ink: string; glyph: string; label: string }> = {
  ok: { bg: 'var(--hc-ok)', ink: '#ffffff', glyph: '', label: 'Só sucessos' },
  some: { bg: 'var(--hc-warn)', ink: '#0b0b0b', glyph: '!', label: 'Alguns erros (menos de 40%)' },
  many: { bg: 'var(--hc-crit)', ink: '#ffffff', glyph: '×', label: 'Muitos erros (40% ou mais)' },
  out: { bg: 'var(--hc-out)', ink: '#ffffff', glyph: '', label: 'Só canceladas ou erro do Hub (fora da conta)' },
  none: { bg: 'transparent', ink: 'transparent', glyph: '', label: 'Sem execução' },
};

function describe(cell: HeatCell) {
  const [ok, err, hub, canceled] = cell;
  const parts = [`${ok} sucesso${ok === 1 ? '' : 's'}`, `${err} erro${err === 1 ? '' : 's'} do robô`];
  if (hub) parts.push(`${hub} erro${hub === 1 ? '' : 's'} do Hub`);
  if (canceled) parts.push(`${canceled} cancelada${canceled === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export function RobotHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const { granularity, buckets } = heatmap;

  // Os robôs com mais erros aparecem primeiro.
  const rows = useMemo(
    () =>
      [...heatmap.rows]
        .map((row) => ({ ...row, errors: row.cells.reduce((s, c) => s + c[1], 0), total: row.cells.reduce((s, c) => s + c[0] + c[1] + c[2] + c[3], 0) }))
        .sort((a, b) => b.errors - a.errors || b.total - a.total || a.name.localeCompare(b.name, 'pt-BR')),
    [heatmap.rows],
  );
  const labelEvery = Math.max(1, Math.ceil(34 / (CELL + GAP)));
  const pointer = hover ?? focus;
  const tipRow = pointer ? rows[pointer.r] : null;
  const tipCell = tipRow && pointer ? tipRow.cells[pointer.c] : null;

  function onKey(e: KeyboardEvent) {
    const moves: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    setFocus((cur) => {
      const base = cur ?? { r: 0, c: 0 };
      return { r: Math.min(rows.length - 1, Math.max(0, base.r + move[0])), c: Math.min(buckets.length - 1, Math.max(0, base.c + move[1])) };
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Resultado por robô, {granularity === 'day' ? 'dia a dia' : granularity === 'week' ? 'semana a semana' : 'mês a mês'}</h2>
          <InfoTip label="Como ler o mapa" wide>
            <p>Cada linha é um robô e cada quadradinho é um {GRANULARITY_LABELS[granularity].one}. A cor mostra como foi aquele {GRANULARITY_LABELS[granularity].one} para o robô:</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              <li><strong>Verde:</strong> só sucessos.</li>
              <li><strong>Amarelo (!):</strong> alguns erros, menos de 40% das concluídas.</li>
              <li><strong>Vermelho (×):</strong> 40% ou mais de erro (a mesma regra do "Crítico").</li>
              <li><strong>Cinza:</strong> só canceladas ou erros do Hub, que ficam fora da conta.</li>
              <li><strong>Vazio:</strong> o robô não rodou.</li>
            </ul>
            <p className="mt-1.5">Os robôs com mais erros ficam no topo. Passe o mouse ou use as setas do teclado para ver os números.</p>
          </InfoTip>
        </div>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-[#2b2b31] dark:text-zinc-300 dark:hover:bg-[#18181b]"
        >
          {asTable ? 'Ver mapa' : 'Ver como tabela'}
        </button>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-zinc-300" aria-label="Legenda do mapa">
        {(['ok', 'some', 'many', 'out', 'none'] as State[]).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span
              className="grid h-3.5 w-3.5 place-items-center rounded-[3px] border border-slate-300 text-[10px] font-bold leading-none dark:border-[#2b2b31]"
              style={{ background: STATE_STYLE[s].bg, color: STATE_STYLE[s].ink, borderColor: s === 'none' ? undefined : 'transparent' }}
              aria-hidden="true"
            >
              {STATE_STYLE[s].glyph}
            </span>
            {STATE_STYLE[s].label}
          </li>
        ))}
      </ul>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-zinc-400">Nenhum robô rodou no período.</p>
      ) : asTable ? (
        <div className="max-h-[420px] overflow-auto rounded-xl border border-slate-200 dark:border-[#2b2b31]">
          <table className="text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-slate-500 dark:bg-[#18181b] dark:text-zinc-400">
              <tr>
                <th className="sticky left-0 bg-slate-50 px-3 py-2 font-medium dark:bg-[#18181b]">Robô</th>
                {buckets.map((b) => <th key={b} className="whitespace-nowrap px-2 py-2 text-right font-medium">{bucketLabel(b, granularity)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.robotId} className="border-t border-slate-100 dark:border-white/[0.06]">
                  <th className="sticky left-0 max-w-[200px] truncate bg-white px-3 py-1.5 text-left font-medium text-slate-800 dark:bg-[#111113] dark:text-zinc-100" title={row.name}>{row.name}</th>
                  {row.cells.map((cell, i) => (
                    <td key={buckets[i]} className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-zinc-300" title={describe(cell)}>
                      {cell[0] + cell[1] + cell[2] + cell[3] === 0 ? '·' : `${cell[0]}✓ ${cell[1]}×${cell[2] + cell[3] ? ` +${cell[2] + cell[3]}` : ''}`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <div
            className="max-h-[520px] overflow-auto rounded-xl border border-slate-200 outline-none focus-visible:ring-4 focus-visible:ring-sky-500/20 dark:border-[#2b2b31]"
            tabIndex={0}
            role="application"
            aria-label="Mapa de resultado por robô. Use as setas do teclado para percorrer."
            onKeyDown={onKey}
            onMouseLeave={() => setHover(null)}
            onBlur={() => setFocus(null)}
          >
            <div style={{ width: LABEL_W + buckets.length * (CELL + GAP) + 12 }}>
              <div className="sticky top-0 z-10 flex bg-white dark:bg-[#111113]" style={{ paddingLeft: LABEL_W, height: 22 }} aria-hidden="true">
                {buckets.map((b, i) => (
                  <div key={b} className="shrink-0 text-[10px] text-slate-400 dark:text-zinc-500" style={{ width: CELL + GAP }}>
                    {i % labelEvery === 0 ? bucketLabel(b, granularity) : ''}
                  </div>
                ))}
              </div>
              {rows.map((row, r) => (
                <div key={row.robotId} className="flex items-center" style={{ height: CELL + GAP }}>
                  <div className="sticky left-0 z-[1] shrink-0 truncate bg-white pr-2 text-xs text-slate-700 dark:bg-[#111113] dark:text-zinc-200" style={{ width: LABEL_W }} title={row.name}>
                    {row.name}
                  </div>
                  {row.cells.map((cell, c) => {
                    const st = cellState(cell);
                    const style = STATE_STYLE[st];
                    const focused = focus?.r === r && focus?.c === c;
                    return (
                      <div
                        key={buckets[c]}
                        role="img"
                        aria-label={`${row.name}, ${bucketTitle(buckets[c], granularity)}: ${st === 'none' ? 'não rodou' : describe(cell)}`}
                        onMouseEnter={() => setHover({ r, c })}
                        className="grid shrink-0 place-items-center rounded-[3px] text-[10px] font-bold leading-none"
                        style={{
                          width: CELL, height: CELL, marginRight: GAP, background: style.bg, color: style.ink,
                          border: st === 'none' ? '1px solid var(--hc-grid)' : undefined,
                          outline: focused ? '2px solid var(--hc-ink)' : hover?.r === r && hover?.c === c ? '2px solid var(--hc-ink-2)' : undefined,
                          outlineOffset: 1,
                        }}
                      >
                        {style.glyph}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          {tipRow && tipCell ? (
            <div role="status" className="pointer-events-none absolute right-2 top-2 z-20 w-60 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-[#2b2b31] dark:bg-[#18181b]">
              <p className="font-semibold text-slate-900 dark:text-white">{tipRow.name}</p>
              <p className="mb-1.5 text-slate-500 dark:text-zinc-400">{bucketTitle(buckets[pointer!.c], granularity)}</p>
              {cellState(tipCell) === 'none' ? (
                <p className="text-slate-500 dark:text-zinc-400">O robô não rodou.</p>
              ) : (
                <>
                  <p className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Sucessos</span><span className="font-medium tabular-nums text-slate-900 dark:text-white">{tipCell[0]}</span></p>
                  <p className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Erros do robô</span><span className="font-medium tabular-nums text-slate-900 dark:text-white">{tipCell[1]}</span></p>
                  <p className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Erros do Hub</span><span className="font-medium tabular-nums text-slate-900 dark:text-white">{tipCell[2]}</span></p>
                  <p className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Canceladas</span><span className="font-medium tabular-nums text-slate-900 dark:text-white">{tipCell[3]}</span></p>
                  <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-500 dark:border-white/10 dark:text-zinc-400">{STATE_STYLE[cellState(tipCell)].label}</p>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
