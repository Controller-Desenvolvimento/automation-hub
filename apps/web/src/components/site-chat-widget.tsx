import { Download, Send, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/auth-context';
import { useChatScope } from '../contexts/chat-scope-context';
import { useHub } from '../contexts/hub-context';
import { api, API_BASE_URL, downloadWithFeedback, getStoredToken } from '../lib/api';
import { MASCOT_ACCENT, MASCOT_SKIN, type MascotSkinId } from '../lib/mascot-skins';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

const STREAMING_ID = 'streaming-reply';

// Cada modo cicla seus próprios frames (extraídos da spritesheet original —
// ver downloads/midas_extracted). "loop: false" é usado pelos modos
// "transientes" — tocam uma vez (duração = frames × interval) e quem
// disparou é responsável por voltar ao modo padrão depois (ver
// `playTransient`).
type MascotMode = 'idle' | 'waiting' | 'running' | 'waving' | 'jumping' | 'failed' | 'review' | 'tablet';

const MASCOT_ANIMATIONS: Record<MascotMode, { frames: number; intervalMs: number; loop: boolean }> = {
  idle: { frames: 6, intervalMs: 220, loop: true },
  waiting: { frames: 6, intervalMs: 240, loop: true },
  running: { frames: 8, intervalMs: 100, loop: true },
  waving: { frames: 6, intervalMs: 110, loop: false },
  jumping: { frames: 6, intervalMs: 90, loop: false },
  failed: { frames: 8, intervalMs: 120, loop: false },
  review: { frames: 6, intervalMs: 220, loop: true },
  tablet: { frames: 8, intervalMs: 200, loop: true },
};

// Ao ocultar: toca o failed quase inteiro primeiro (sem encolher ainda) e só
// no finalzinho encolhe de uma vez (rápido) pra dar a impressão de que ele
// "entrou" na bolinha. A de "crescer" ao trazer de volta é só um pop rápido.
const HIDE_ANIM_MS = MASCOT_ANIMATIONS.failed.frames * MASCOT_ANIMATIONS.failed.intervalMs;
const SHRINK_ANIM_MS = 150;
const SHOW_ANIM_MS = 280;
const HINT_AUTO_DISMISS_MS = 30 * 1000;

interface SiteChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  attachmentName?: string | null;
}

// Renderização leve de markdown — só o suficiente pro que o assistente
// realmente usa (negrito **assim** e linhas soltas, inclusive bullets "- ").
// Sem biblioteca externa: o conteúdo vem só do nosso próprio backend/modelo,
// nunca de HTML de terceiros, então não precisa de um parser completo.
function renderMessageContent(content: string) {
  return content.split('\n').map((line, lineIndex) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '');
    return (
      <div key={lineIndex}>
        {parts.length > 0
          ? parts.map((part, partIndex) =>
              part.startsWith('**') && part.endsWith('**') ? (
                <strong key={partIndex}>{part.slice(2, -2)}</strong>
              ) : (
                <span key={partIndex}>{part}</span>
              ),
            )
          : ' '}
      </div>
    );
  });
}

// Mascote "Midas" — só a imagem, sem fundo/círculo por trás. Cicla os
// frames do modo atual (ver MASCOT_ANIMATIONS). Modos "loop: false" tocam
// uma vez e ficam parados no último frame — quem disparou é responsável por
// voltar ao modo padrão depois (ver `playTransient`).
function MascotIcon({
  heightClassName,
  mode,
  skin,
  runDirection = 'right',
}: {
  heightClassName: string;
  mode: MascotMode;
  skin: MascotSkinId;
  runDirection?: 'left' | 'right';
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    const { frames, intervalMs, loop } = MASCOT_ANIMATIONS[mode];
    const id = setInterval(() => {
      setFrame((f) => (loop ? (f + 1) % frames : Math.min(f + 1, frames - 1)));
    }, intervalMs);
    return () => clearInterval(id);
  }, [mode, skin]);

  const src =
    mode === 'running'
      ? `/mascots/${skin}/mascot-run-${runDirection}-${frame}.png`
      : `/mascots/${skin}/mascot-${mode}-${frame}.png`;

  return (
    <img
      src={src}
      alt="João"
      draggable={false}
      className={cn('w-auto shrink-0 select-none object-contain drop-shadow-md', heightClassName)}
    />
  );
}

// Balão de fala: aparece de forma contextual — depois que a pessoa fica um
// tempo parada numa página sem navegar (possível sinal de "travou"/"não
// achou") — com uma frase relevante pra aquela página, sorteada de um pool
// pra não repetir sempre a mesma. Tem um intervalo mínimo entre aparições
// pra não ficar chato.
const HINT_IDLE_DELAY_MS = 25 * 1000;
const HINT_MIN_INTERVAL_MS = 4 * 60 * 1000;
// "Oi" espontâneo na tela inicial: um aceno a cada 1 a 2 min (sorteado), só com a aba visível.
const IDLE_WAVE_MIN_MS = 60 * 1000;
const IDLE_WAVE_MAX_MS = 120 * 1000;

const GENERIC_HINTS = [
  'Oi, eu sou o João! Dúvidas sobre o Hub? Pergunta pra mim 👋',
  'Travou em algum lugar? Clica em mim que o João ajuda',
  'Não achou o que procurava? Pode perguntar, eu ajudo',
];

const ROUTE_HINTS: { match: (path: string) => boolean; messages: string[] }[] = [
  {
    match: (p) => p.startsWith('/robots'),
    messages: ['Não achou o robô que precisa? Me pergunta que o João ajuda a encontrar', 'Quer saber se existe automação pra algo? É só perguntar pro João'],
  },
  {
    match: (p) => p.startsWith('/schedules'),
    messages: ['Quer ajuda pra criar um agendamento? O João faz com você 👋'],
  },
  {
    match: (p) => p.startsWith('/history') || p.startsWith('/results'),
    messages: ['Procurando uma execução ou um arquivo? O João ajuda a achar'],
  },
  {
    match: (p) => p.startsWith('/time-savings'),
    messages: ['Quer saber quanto tempo já foi economizado? Pergunta pro João'],
  },
  {
    match: (p) => p.startsWith('/automation-requests') || p.startsWith('/dashboard-requests'),
    messages: ['Quer que o João já registre esse pedido? Só me contar o que precisa'],
  },
];

function pickHintMessage(pathname: string): string {
  const pool = ROUTE_HINTS.find((r) => r.match(pathname))?.messages ?? GENERIC_HINTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Baixa todos os quadros do mascote em segundo plano, depois da página carregar: sem isso,
// cada troca de quadro (a cada ~100 ms) esperava a rede na primeira volta e a animação engasgava.
let mascotFramesPreloaded = false;
function preloadMascotFrames(skin: MascotSkinId) {
  if (mascotFramesPreloaded) return;
  mascotFramesPreloaded = true;
  (Object.keys(MASCOT_ANIMATIONS) as MascotMode[]).forEach((mode) => {
    const names = mode === 'running' ? ['run-left', 'run-right'] : [mode];
    names.forEach((name) => {
      for (let i = 0; i < MASCOT_ANIMATIONS[mode].frames; i += 1) {
        new Image().src = `/mascots/${skin}/mascot-${name}-${i}.png`;
      }
    });
  });
}

export function SiteChatWidget() {
  const { user } = useAuth();
  const { notify } = useHub();
  const { biScope } = useChatScope();
  const scopeKey = biScope?.conversationScope ?? 'hub';
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const location = useLocation();
  const [progressText, setProgressText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<SiteChatMessage[]>([]);
  // Conversa cujo histórico já está carregado na tela ("hub" ou "dash:<id>").
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [sendingScope, setSendingScope] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Resposta em andamento NESTA conversa (pode estar em andamento em outra, se a pessoa trocou de tela).
  const sendingHere = sending && sendingScope === scopeKey;
  const [hintText, setHintText] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [runDirection, setRunDirection] = useState<'left' | 'right'>('right');
  const [transientMode, setTransientMode] = useState<MascotMode | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => preloadMascotFrames(MASCOT_SKIN), 800);
    return () => window.clearTimeout(timer);
  }, []);
  const [hidingAnim, setHidingAnim] = useState(false);
  const [showingAnim, setShowingAnim] = useState(false);
  const lastHintAtRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; lastX: number; originX: number; originY: number; moved: boolean } | null>(null);
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shrinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Toca uma animação "de reação" (jumping ao soltar, waving ao abrir, failed
  // ao fechar) por uma vez só, depois volta sozinho ao modo padrão (waiting
  // ou review, calculado no render).
  function playTransient(mode: MascotMode) {
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    setTransientMode(mode);
    const { frames, intervalMs } = MASCOT_ANIMATIONS[mode];
    transientTimerRef.current = setTimeout(() => setTransientMode(null), frames * intervalMs);
  }

  useEffect(() => () => {
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (shrinkTimerRef.current) clearTimeout(shrinkTimerRef.current);
  }, []);

  useEffect(() => {
    setHintText(null);
    if (open || hidden) return;
    const timer = setTimeout(() => {
      if (Date.now() - lastHintAtRef.current < HINT_MIN_INTERVAL_MS) return;
      lastHintAtRef.current = Date.now();
      setHintText(pickHintMessage(location.pathname));
    }, HINT_IDLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [location.pathname, open, hidden]);

  // Aceno espontâneo, só pra dar um oi: na tela inicial, com o chat fechado, sem arrastar,
  // sem balão e sem outra animação rolando. O intervalo é sorteado a cada vez pra não ficar
  // previsível nem virar flood, e pula o aceno se a aba estiver em segundo plano.
  const calmRef = useRef(true);
  calmRef.current = !dragging && transientMode === null && hintText === null;
  useEffect(() => {
    if (location.pathname !== '/' || open || hidden) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (calmRef.current && !document.hidden) playTransient('waving');
        schedule();
      }, IDLE_WAVE_MIN_MS + Math.random() * (IDLE_WAVE_MAX_MS - IDLE_WAVE_MIN_MS));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [location.pathname, open, hidden]);

  // Some sozinho depois de um tempo, mesmo sem interação.
  useEffect(() => {
    if (!hintText) return;
    const timer = setTimeout(() => setHintText(null), HINT_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [hintText]);

  function dismissHint() {
    setHintText(null);
  }

  // Encolhe o mascote (com a animação failed) até sumir dentro da bolinha
  // pequena — dá a impressão de que ele "entrou" nela.
  function handleHideMascot() {
    playTransient('failed');
    setHintText(null);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (shrinkTimerRef.current) clearTimeout(shrinkTimerRef.current);
    // Encolhe só no finalzinho do failed, não junto com ele.
    shrinkTimerRef.current = setTimeout(() => {
      setHidingAnim(true);
    }, HIDE_ANIM_MS - SHRINK_ANIM_MS);
    hideTimerRef.current = setTimeout(() => {
      setHidden(true);
      setHidingAnim(false);
    }, HIDE_ANIM_MS);
  }

  // Traz de volta no canto padrão (não no último lugar que foi arrastado) e
  // cresce a partir da bolinha pequena.
  function handleShowMascot() {
    setPosition(null);
    setHidden(false);
    setShowingAnim(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShowingAnim(false));
    });
    playTransient('waving'); // ao voltar da bolinha, ele cresce já acenando
  }

  function handleCloseChat() {
    setOpen(false);
  }

  // Cada conversa (hub ou um painel) tem o seu histórico: ao abrir o chat, ou
  // ao entrar/sair de um painel, mostra o histórico da conversa certa.
  useEffect(() => {
    if (!open || loadedScope === scopeKey) return;
    let cancelled = false;
    setMessages([]);
    void (async () => {
      try {
        const data = await api<SiteChatMessage[]>(`/site-chat/messages?scope=${encodeURIComponent(scopeKey)}`);
        if (!cancelled) setMessages(data);
      } catch {
        // silencioso — o widget ainda abre, só começa sem histórico
      } finally {
        if (!cancelled) setLoadedScope(scopeKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadedScope, scopeKey]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  if (!user) return null;

  const skin = MASCOT_SKIN;
  // Parado: com um painel/BI aberto o João fica mexendo no tablet; no resto do hub, só esperando.
  const restMode: MascotMode = biScope ? 'tablet' : 'waiting';
  const accent = MASCOT_ACCENT;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={handleShowMascot}
        title="Mostrar o João"
        style={{ backgroundColor: accent }}
        className="fixed bottom-5 right-5 z-50 grid h-8 w-8 place-items-center rounded-full text-white opacity-60 shadow-lg transition hover:opacity-100"
      >
        <MascotIcon heightClassName="h-6" mode="waiting" skin={skin} />
      </button>
    );
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending) return;
    setInput('');
    setSending(true);
    setProgressText(null);
    // Se a pessoa trocar de conversa (entrar/sair de um painel) antes da resposta
    // terminar, o resultado não pode aparecer na conversa errada: fica salvo no
    // servidor e aparece quando ela voltar.
    const scopeAtSend = scopeKey;
    const stillHere = () => scopeRef.current === scopeAtSend;
    setSendingScope(scopeAtSend);
    // BI aberto com painel vinculado: guarda o escopo no momento do envio (se o
    // usuário fechar o BI no meio da resposta, esta pergunta continua sendo dele).
    // Painel aberto direto: também manda o que está na tela (página + filtros), lido agora.
    const screenContext = biScope?.dashboardId ? biScope.getScreenContext?.() ?? null : null;
    const chatContext = biScope?.dashboardId
      ? { dashboardId: biScope.dashboardId, ...(screenContext ? { screen: screenContext } : {}) }
      : biScope?.siteId
        ? { siteId: biScope.siteId }
        : null;
    const optimistic: SiteChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const token = getStoredToken();
      const response = await fetch(`${API_BASE_URL}/site-chat/messages/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ content, ...(chatContext ? { context: chatContext } : {}) }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Erro ${response.status} ao falar com o João.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedText = '';
      let finished = false;

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith('data:')) continue;
          const payload = JSON.parse(line.slice(5).trim()) as {
            delta?: string;
            progress?: string;
            done?: boolean;
            error?: string;
            userMessage?: SiteChatMessage;
            assistantMessage?: SiteChatMessage;
          };

          if (payload.error) {
            throw new Error(payload.error);
          }
          if (payload.progress && stillHere()) {
            setProgressText(payload.progress);
          }
          if (payload.delta) {
            streamedText += payload.delta;
            if (!stillHere()) continue;
            setMessages((prev) => {
              const withoutStreaming = prev.filter((m) => m.id !== STREAMING_ID);
              return [
                ...withoutStreaming,
                { id: STREAMING_ID, role: 'assistant', content: streamedText, createdAt: new Date().toISOString() },
              ];
            });
          }
          if (payload.done && payload.assistantMessage) {
            finished = true;
            const finalAssistantMessage = payload.assistantMessage;
            if (!stillHere()) continue;
            setMessages((prev) => [
              ...prev.filter((m) => m.id !== optimistic.id && m.id !== STREAMING_ID),
              { ...optimistic, id: `${optimistic.id}-sent` },
              finalAssistantMessage,
            ]);
          }
        }
      }
    } catch (error) {
      if (stillHere()) {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id && m.id !== STREAMING_ID));
        setInput(content);
      }
      notify(error instanceof Error ? error.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSending(false);
      setSendingScope(null);
      setProgressText(null);
    }
  }

  async function handleClear() {
    try {
      await api(`/site-chat/messages?scope=${encodeURIComponent(scopeKey)}`, { method: 'DELETE' });
      setMessages([]);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível limpar a conversa.');
    }
  }

  // Arrastar o mascote: só quando o chat está fechado (senão ia brigar com o
  // posicionamento do painel aberto). Um clique sem arrastar (moveu menos de
  // 4px) ainda abre/fecha o chat normalmente — só "trava" o arrasto quando a
  // pessoa realmente moveu o dedo/mouse.
  const MASCOT_W = 88;
  const MASCOT_H = 140;

  function handleMascotPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (open) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      originX: position?.x ?? rect.left,
      originY: position?.y ?? rect.top,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleMascotPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;

    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }

    // Direção do "correr" olha pro movimento desde o último frame, não desde
    // o início do arrasto — senão só troca de lado quando o ponteiro volta a
    // passar pelo ponto de partida, o que trava ele num lado só.
    const stepDx = e.clientX - drag.lastX;
    if (Math.abs(stepDx) > 1) setRunDirection(stepDx > 0 ? 'right' : 'left');
    drag.lastX = e.clientX;

    const maxX = window.innerWidth - MASCOT_W - 8;
    const maxY = window.innerHeight - MASCOT_H - 8;
    setPosition({
      x: Math.min(Math.max(drag.originX + dx, 8), Math.max(8, maxX)),
      y: Math.min(Math.max(drag.originY + dy, 8), Math.max(8, maxY)),
    });
  }

  function handleMascotPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.moved) {
      playTransient('jumping');
      return;
    }
    dismissHint();
    setOpen(true);
    playTransient('waving');
  }

  // A posição arrastada só vale pro botão flutuante com o chat fechado —
  // com o chat aberto, sempre ancora no canto padrão (senão o painel podia
  // abrir cortado pra fora da tela dependendo de onde o robô foi largado).
  const usesCustomPosition = !open && position !== null;

  return (
    <div
      className={cn('flex flex-col items-end gap-3', !usesCustomPosition && 'fixed bottom-5 right-5 z-50')}
      style={usesCustomPosition ? { position: 'fixed', left: position.x, top: position.y, zIndex: 50 } : undefined}
    >
      {open ? (
        <div className="flex h-[min(70vh,520px)] w-[min(92vw,360px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-[#151517]">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
            <div className="flex items-center gap-2.5">
              <MascotIcon heightClassName="h-14" mode={transientMode ?? (sendingHere ? 'review' : restMode)} skin={skin} />
              <div>
                <div className="text-sm font-semibold text-slate-950 dark:text-white">João</div>
                <div className="whitespace-nowrap text-[11px] text-slate-400 dark:text-zinc-500" title={biScope?.name}>
                  {biScope ? `Respondendo com os dados deste ${biScope.dashboardId ? 'painel' : 'BI'}` : 'Tire suas dúvidas sobre o Hub'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Limpar conversa"
                onClick={() => void handleClear()}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Fechar"
                onClick={handleCloseChat}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-zinc-500">
                {biScope
                  ? `Oi, eu sou o João! Esta é a nossa conversa sobre este ${biScope.dashboardId ? 'painel' : 'BI'}, separada do chat do hub. Pergunte sobre os dados dele.`
                  : 'Oi, eu sou o João! Posso ajudar com dúvidas sobre como usar o Hub — robôs disponíveis, agendamentos, relatórios e mais.'}
              </p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
                      m.role === 'user'
                        ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950'
                        : 'bg-slate-100 text-slate-800 dark:bg-zinc-800 dark:text-zinc-200',
                    )}
                  >
                    {renderMessageContent(m.content)}
                    {m.attachmentName ? (
                      <button
                        type="button"
                        onClick={() =>
                          void downloadWithFeedback(`${API_BASE_URL}/site-chat/messages/${m.id}/attachment`, m.attachmentName!, notify)
                        }
                        className="mt-2 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        <Download className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{m.attachmentName}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
            {sendingHere && !messages.some((m) => m.id === STREAMING_ID) ? (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-slate-100 px-3.5 py-2 text-sm text-slate-400 dark:bg-zinc-800 dark:text-zinc-500">
                  {progressText ?? 'pensando...'}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-end gap-2 border-t border-slate-100 p-3 dark:border-zinc-800">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={biScope ? `Pergunte sobre este ${biScope.dashboardId ? 'painel' : 'BI'}...` : 'Pergunte ao João...'}
              rows={1}
              className="max-h-28 min-h-[38px] resize-none text-sm"
            />
            <Button size="sm" className="h-[46px] w-[46px] shrink-0 px-0" onClick={() => void handleSend()} disabled={sending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <div
        className="relative origin-bottom-right transition-all ease-out"
        style={{
          transitionDuration: `${hidingAnim ? SHRINK_ANIM_MS : SHOW_ANIM_MS}ms`,
          transform: hidingAnim || showingAnim ? 'scale(0)' : 'scale(1)',
          opacity: hidingAnim || showingAnim ? 0 : 1,
        }}
      >
        {!open && hintText ? (
          <div className="absolute bottom-full right-2 mb-2 w-44">
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                playTransient('waving');
                dismissHint();
              }}
              style={{ backgroundColor: accent }}
              className="block w-full rounded-xl px-3 py-2 text-left text-xs font-medium leading-snug text-white shadow-lg"
            >
              {hintText}
            </button>
            <span style={{ backgroundColor: accent }} className="absolute -bottom-1.5 right-4 h-3 w-3 rotate-45" />
          </div>
        ) : null}

        {!open ? (
          <button
            type="button"
            title="Ocultar o João"
            onClick={(e) => {
              e.stopPropagation();
              handleHideMascot();
            }}
            className="absolute -right-1 -top-1 z-10 grid h-6 w-6 place-items-center rounded-full bg-slate-950 text-white shadow ring-2 ring-white hover:bg-slate-800 dark:ring-[#151517]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}

        <button
          type="button"
          onPointerDown={handleMascotPointerDown}
          onPointerMove={handleMascotPointerMove}
          onPointerUp={handleMascotPointerUp}
          onPointerCancel={handleMascotPointerUp}
          onClick={open ? handleCloseChat : undefined}
          onMouseEnter={dismissHint}
          title={open ? 'Fechar' : 'João — arraste pra mover'}
          className={cn('grid touch-none place-items-center transition', !dragging && 'hover:scale-105')}
        >
          {open ? (
            <div className="grid h-14 w-14 place-items-center rounded-full bg-slate-950 text-white shadow-xl dark:bg-white dark:text-slate-950">
              <X className="h-6 w-6" />
            </div>
          ) : (
            <MascotIcon
              heightClassName="h-[8.5rem]"
              mode={dragging ? 'running' : (transientMode ?? (hintText ? 'idle' : restMode))}
              skin={skin}
              runDirection={runDirection}
            />
          )}
        </button>
      </div>
    </div>
  );
}
