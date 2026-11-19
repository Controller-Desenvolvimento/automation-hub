import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Peças do visual do protótipo para "Robôs sem ganho" e "Simular ganhos" (classes `.sg` em index.css).

/** O "i" do protótipo: abre a explicação ao passar o mouse, focar ou tocar; fica inteira na janela (embaixo ou em cima do "i"). */
export function SgInfo({ label, children }: { label: string; children: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const hide = () => {
    setAnchor(null);
    setPos(null);
  };
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const w = tipRef.current.offsetWidth;
    const h = tipRef.current.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - w - margin));
    const below = anchor.bottom + margin;
    const above = anchor.top - margin - h;
    const top = below + h <= window.innerHeight - margin ? below : above >= margin ? above : Math.max(margin, window.innerHeight - h - margin);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [anchor]);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="it"
        aria-label={label}
        aria-expanded={!!anchor}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => e.key === 'Escape' && hide()}
      >
        i
      </button>
      {anchor ? (
        <div ref={tipRef} role="tooltip" className="sg-tip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
          {children}
        </div>
      ) : null}
    </>
  );
}

/** Segmentado do protótipo (botões lado a lado, o escolhido em azul). */
export function SgSeg<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {items.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => value !== v && onChange(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}
