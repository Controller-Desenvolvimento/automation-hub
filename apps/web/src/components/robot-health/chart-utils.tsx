import { useEffect, useState } from 'react';

/** Retângulo com os cantos de cima arredondados (a base fica reta): ponta dos dados das barras. */
export function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/** Máximo "redondo" do eixo (4 intervalos): 0, 5, 10, 15, 20... */
export function niceMax(value: number) {
  if (value <= 4) return 4;
  const raw = value / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw) ?? pow * 10;
  return step * 4;
}

/** Largura disponível de um elemento (o gráfico ocupa a largura toda e só rola quando há barras demais). */
export function useContainerWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

export const CHART = {
  H: 220,
  M: { top: 12, right: 12, bottom: 30, left: 40 },
  BAR_MAX: 24,
  SLOT_MIN: 26,
  GAP: 2,
  RADIUS: 4,
} as const;
