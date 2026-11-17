import { Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatScope } from '../contexts/chat-scope-context';
import { PanelSkeletonBody } from './panel-skeleton';
import { panelPathFromLocation } from '../lib/panel-path';
import { getStoredToken } from '../lib/api';
import { readPanelScreenContext } from '../lib/panel-screen-context';
import type { Dashboard } from '../lib/types';

// Os links do menu do próprio painel (Colaborador, Cliente, Tarefas...) viram
// "replace": navegar entre as abas do painel não cria entradas no histórico do
// navegador, então UM "voltar" fecha o painel (senão o "voltar" só desfazia a
// aba interna e o painel continuava aberto). Só links comuns para páginas do
// próprio painel; downloads, links externos e âncoras seguem o caminho normal.
function keepPanelNavigationOutOfHistory(iframe: HTMLIFrameElement | null) {
  try {
    const win = iframe?.contentWindow;
    const doc = iframe?.contentDocument;
    if (!win || !doc) return;
    // Idempotente: o documento pode ser instrumentado cedo (polling) e de novo no onLoad.
    const marked = doc as Document & { __hubNavKept?: boolean };
    if (marked.__hubNavKept || !doc.body) return;
    marked.__hubNavKept = true;
    // Na fase de bolha: roda depois dos handlers do painel, que podem ter cancelado o clique.
    doc.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, win.location.href);
      if (url.origin !== win.location.origin) return;
      if (!/.html?$/.test(url.pathname)) return;
      if (url.pathname === win.location.pathname && url.search === win.location.search) return;
      event.preventDefault();
      win.location.replace(url.href);
    });
  } catch {
    // iframe de outra origem ou ainda sem documento: mantém o comportamento padrão
  }
}

// Tela cheia do navegador: pela API (botão da faixa) ou pelo F11. O F11 não avisa a página; o Chrome liga a regra
// "display-mode: fullscreen" e, por segurança, também vale a janela do tamanho exato da tela sem a barra do navegador.
function isFullscreenNow() {
  if (document.fullscreenElement) return true;
  if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
  const { screen } = window;
  return window.outerWidth >= screen.width - 1 && window.outerHeight >= screen.height - 1 && window.outerHeight - window.innerHeight <= 2;
}

// Faixa do nome do painel: aparece ao abrir e recolhe; volta ao passar o mouse na tira do topo.
const BAR_INTRO_MS = 2500; // ao abrir, a faixa fica visível por um instante (a pessoa descobre que ela existe)
const BAR_HIDE_MS = 500; // ao sair com o mouse, espera um pouco antes de recolher (dá tempo de chegar ao X)
const BAR_TOUCH_MS = 4000; // no toque (sem mouse), a faixa fica aberta por mais tempo

// Painel aberto em tela cheia dentro do hub (botão "Ver" da aba Painéis), no
// mesmo molde do "Ver" dos BIs. O painel é servido pelo próprio hub em
// /d/<slug>/ (mesma origem), então o chat do hub consegue ler os filtros da
// tela dele e mandá-los junto com a pergunta. O balão de chat do próprio
// painel continua lá dentro, como na aba separada.
export function DashboardViewer({
  dashboard,
  onClose,
  initialPath,
  onPathChange,
}: {
  dashboard: Dashboard;
  onClose: () => void;
  // Página interna em que o painel abre (ex.: "static/tarefas.html"); só vale na abertura.
  initialPath?: string | null;
  // Avisa a cada página interna carregada, pra o hub guardar na URL (F5 volta pra mesma aba).
  onPathChange?: (path: string) => void;
}) {
  const { setBiScope } = useChatScope();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [loaded, setLoaded] = useState(false);
  const [barOpen, setBarOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(isFullscreenNow);
  const hideTimer = useRef<number | undefined>(undefined);
  const showBar = () => {
    window.clearTimeout(hideTimer.current);
    setBarOpen(true);
  };
  const hideBarSoon = (ms = BAR_HIDE_MS) => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setBarOpen(false), ms);
  };

  // O token vai na URL só na primeira carga: o hub troca por um cookie e redireciona.
  const rootSrc = useMemo(() => `/d/${dashboard.slug}/?t=${encodeURIComponent(getStoredToken() ?? '')}`, [dashboard.slug]);

  // Só a primeira página importa (depois o painel navega sozinho dentro do iframe).
  const [startPath] = useState(initialPath ?? null);
  // Abrindo numa página interna: o "?t=" não funciona em caminho de arquivo (o hub
  // redireciona pra ".../arquivo.html/"), então o login é "aquecido" pela raiz do
  // painel primeiro e o iframe abre o caminho direto, já com o cookie.
  const [src, setSrc] = useState<string | null>(startPath ? null : rootSrc);
  useEffect(() => {
    if (!startPath) return;
    let cancelled = false;
    void (async () => {
      try {
        await fetch(rootSrc, { redirect: 'manual', credentials: 'same-origin' });
        if (!cancelled) setSrc(`/d/${dashboard.slug}/${startPath}`);
      } catch {
        if (!cancelled) setSrc(rootSrc);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Só painéis do tipo servidor têm chat de IA próprio (rota /chatkit).
  const hasChat = dashboard.type === 'server';
  useEffect(() => {
    if (!hasChat) return;
    setBiScope({
      dashboardId: dashboard.id,
      name: dashboard.name,
      getScreenContext: () => readPanelScreenContext(iframeRef.current?.contentDocument),
      conversationScope: `dash:${dashboard.id}`,
    });
    return () => setBiScope(null);
  }, [hasChat, dashboard.id, dashboard.name, setBiScope]);

  // O onLoad do iframe só dispara depois de TODOS os recursos (gráficos, fontes, imagens):
  // um clique no menu do painel antes disso entrava no histórico e o "fechar" só voltava
  // uma aba interna. Por isso o tratamento é instalado assim que o documento existe.
  useEffect(() => {
    const timer = window.setInterval(() => keepPanelNavigationOutOfHistory(iframeRef.current), 50);
    return () => window.clearInterval(timer);
  }, []);

  // Recolhe a faixa depois da apresentação inicial.
  useEffect(() => {
    hideTimer.current = window.setTimeout(() => setBarOpen(false), BAR_INTRO_MS);
    return () => window.clearTimeout(hideTimer.current);
  }, []);

  // Em tela cheia (F11 ou o botão da faixa), a faixa e a tira somem; o Esc / F11 saem da tela cheia.
  useEffect(() => {
    const update = () => setFullscreen(isFullscreenNow());
    const media = window.matchMedia?.('(display-mode: fullscreen)');
    window.addEventListener('resize', update);
    document.addEventListener('fullscreenchange', update);
    media?.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('fullscreenchange', update);
      media?.removeEventListener?.('change', update);
    };
  }, []);

  function toggleFullscreen() {
    // A página inteira (não só o painel): o chat do hub continua visível em tela cheia.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-white dark:bg-[#0a0a0b]">
      {/* Tira fina do topo: o painel roda num iframe (o hub não "vê" o mouse lá dentro), então é ela que
          detecta o mouse e abre a faixa. No toque, um toque abre. Some em tela cheia. */}
      {!fullscreen ? (
        <div
          aria-hidden="true"
          onMouseEnter={showBar}
          onMouseLeave={() => hideBarSoon()}
          onPointerDown={(event) => {
            if (event.pointerType !== 'mouse') {
              showBar();
              hideBarSoon(BAR_TOUCH_MS);
            }
          }}
          className="flex h-1.5 shrink-0 cursor-pointer items-start justify-center border-b border-slate-200 bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113]"
        >
          <span className="mt-px h-[3px] w-10 rounded-full bg-slate-300 dark:bg-zinc-600" />
        </div>
      ) : null}
      {!fullscreen ? (
        <div
          onMouseEnter={showBar}
          onMouseLeave={() => hideBarSoon()}
          onFocusCapture={showBar}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideBarSoon();
          }}
          className={`absolute inset-x-0 top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 transition duration-200 ease-out dark:border-[#2b2b31] dark:bg-[#111113] ${
            barOpen ? 'translate-y-0 shadow-md' : '-translate-y-full shadow-none'
          }`}
        >
          <span className="flex-1 truncate font-medium text-slate-900 dark:text-white">{dashboard.name}</span>
          <button
            type="button"
            aria-label="Tela cheia"
            title="Tela cheia (Esc ou F11 para sair)"
            onClick={toggleFullscreen}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-[#1b1b20]"
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            aria-label="Fechar visualização"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-[#1b1b20]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="relative flex-1">
        {src ? (
          <iframe
            ref={iframeRef}
            src={src}
            title={dashboard.name}
            className="absolute inset-0 h-full w-full border-0"
            allow="fullscreen"
            onLoad={() => {
              setLoaded(true);
              keepPanelNavigationOutOfHistory(iframeRef.current);
              try {
                const current = panelPathFromLocation(iframeRef.current?.contentWindow?.location.pathname ?? '', dashboard.slug);
                if (current) onPathChange?.(current);
              } catch {
                // iframe de outra origem: não há como saber a página
              }
            }}
          />
        ) : null}
        {!loaded ? <PanelSkeletonBody className="pointer-events-none absolute inset-0" /> : null}
      </div>
    </div>
  );
}
