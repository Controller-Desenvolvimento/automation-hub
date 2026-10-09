import { X } from 'lucide-react';
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
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-[#0a0a0b]">
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-[#2b2b31] dark:bg-[#111113]">
        <span className="flex-1 truncate font-medium text-slate-900 dark:text-white">{dashboard.name}</span>
        <button
          type="button"
          aria-label="Fechar visualização"
          onClick={onClose}
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-[#1b1b20]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
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
