import { AlertCircle, Check, CheckCircle, Clock, Copy, Edit2, ExternalLink, Eye, EyeOff, LayoutGrid, Plus, RefreshCw, Search, Server, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { DashboardViewer } from '../components/dashboard-viewer';
import { PanelSkeleton } from '../components/panel-skeleton';
import { PageHeader } from '../components/page-header';
import { SiteFavicon } from '../components/site-favicon';
import { StatusDot } from '../components/status-dot';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useAuth } from '../contexts/auth-context';
import { useChatScope } from '../contexts/chat-scope-context';
import { removeBootCover } from '../lib/boot-cover';
import { parsePanelPath } from '../lib/panel-path';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import type { Dashboard, SharedCredential, Site, SiteCategory, SiteStatus } from '../lib/types';
import { departmentLabel, siteCategoryLabel, siteStatusLabel, timeAgo } from '../lib/utils';

const STATUS_PRIORITY: Record<SiteStatus, number> = { down: 0, maintenance: 1, online: 2 };
const SITE_CATEGORIES: SiteCategory[] = ['sistema', 'bi'];
const POLL_INTERVAL_MS = 15_000;

type Tab = SiteCategory | 'paineis' | 'credenciais';

type SiteDraft = {
  id?: string;
  name: string;
  url: string;
  description: string;
  category: SiteCategory;
  maintenanceOverride: boolean;
  allowedDepartments: string[];
  minRole: 'employee' | 'manager';
  powerbiGroupId: string;
  powerbiDatasetId: string;
  powerbiScheduledTimes: string[];
  powerbiShowRefresh: boolean;
  ssoEnabled: boolean;
  linkedDashboardId: string;
};

const emptySiteDraft = (category: SiteCategory): SiteDraft => ({
  name: '', url: '', description: '', category, maintenanceOverride: false,
  allowedDepartments: [], minRole: 'employee',
  powerbiGroupId: '', powerbiDatasetId: '', powerbiScheduledTimes: [], powerbiShowRefresh: true,
  ssoEnabled: false, linkedDashboardId: '',
});

type CredDraft = {
  name: string;
  url: string;
  login: string;
  password: string;
  notes: string;
  allowedDepartments: string[];
  minRole: 'employee' | 'manager';
};

const emptyDraft = (): CredDraft => ({ name: '', url: '', login: '', password: '', notes: '', allowedDepartments: [], minRole: 'employee' });

function isPowerBIRefreshPending(status?: string | null) {
  return status === 'Unknown' || status === 'InProgress';
}

export function SitesPage() {
  const { user } = useAuth();
  const { notify, departments } = useHub();
  const { setBiScope } = useChatScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [biRefreshResults, setBiRefreshResults] = useState<Record<string, 'ok' | 'error'>>({});
  const [viewingSiteId, setViewingSiteId] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [dashboardsLoaded, setDashboardsLoaded] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dashboardsPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [viewerIframeUrl, setViewerIframeUrl] = useState<string | null>(null);

  // Site form state
  const [showSiteForm, setShowSiteForm] = useState(false);
  const [siteDraft, setSiteDraft] = useState<SiteDraft>(emptySiteDraft('sistema'));
  const [savingSite, setSavingSite] = useState(false);
  const [deletingSiteId, setDeletingSiteId] = useState<string | null>(null);

  // Credentials state
  const [credentials, setCredentials] = useState<SharedCredential[]>([]);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showCredForm, setShowCredForm] = useState(false);
  const [editingCred, setEditingCred] = useState<SharedCredential | null>(null);
  const [credDraft, setCredDraft] = useState<CredDraft>(emptyDraft());
  const [savingCred, setSavingCred] = useState(false);
  const [deletingCredId, setDeletingCredId] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';

  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [deletingDashboardId, setDeletingDashboardId] = useState<string | null>(null);

  const rawTab = searchParams.get('tab');
  const activeTab: Tab = rawTab === 'bi' ? 'bi' : rawTab === 'paineis' ? 'paineis' : rawTab === 'credenciais' ? 'credenciais' : 'sistema';

  function setTab(tab: Tab) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    next.delete('painel');
    next.delete('pagina');
    setSearchParams(next);
  }

  useEffect(() => {
    void load();
    void loadCredentials();
    void loadDashboards();
  }, []);

  // Lock body scroll while any modal is open so the background doesn't scroll
  useEffect(() => {
    const anyOpen = showSiteForm || showCredForm || Boolean(viewingSiteId);
    if (anyOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [showSiteForm, showCredForm, viewingSiteId]);

  useEffect(() => {
    const q = searchParams.get('q');
    if (q !== null) setQuery(q);
  }, [searchParams.get('q')]);

  useEffect(() => {
    const hasBiSites = sites.some((s) => s.category === 'bi' && s.powerbiDatasetId);
    if (hasBiSites && !pollTimerRef.current) {
      pollTimerRef.current = setInterval(() => void loadSilent(), POLL_INTERVAL_MS);
    }
    if (!hasBiSites && pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [sites]);

  // Atualizações de painel podem levar bem mais que alguns segundos (fontes
  // pesadas passam de 10min) — sem isso o status/"Última atualização" só
  // refletia a realidade depois de um F5, mesmo quando a atualização (por
  // esta aba ou por outra pessoa/agendamento) já tinha terminado.
  useEffect(() => {
    if (activeTab === 'paineis' && !dashboardsPollTimerRef.current) {
      dashboardsPollTimerRef.current = setInterval(() => void loadDashboards(), POLL_INTERVAL_MS);
    }
    if (activeTab !== 'paineis' && dashboardsPollTimerRef.current) {
      clearInterval(dashboardsPollTimerRef.current);
      dashboardsPollTimerRef.current = null;
    }
    return () => {
      if (dashboardsPollTimerRef.current) {
        clearInterval(dashboardsPollTimerRef.current);
        dashboardsPollTimerRef.current = null;
      }
    };
  }, [activeTab]);

  async function load() {
    try {
      setLoading(true);
      const data = await api<Site[]>('/sites');
      setSites(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar os sites.');
    } finally {
      setLoading(false);
    }
  }

  async function loadSilent() {
    try {
      const data = await api<Site[]>('/sites');
      setSites(data);
    } catch {
      // silencioso
    }
  }

  async function loadDashboards() {
    try {
      const data = await api<Dashboard[]>('/dashboards');
      setDashboards(data);
    } catch {
      // silencioso — não bloqueia a página se falhar
    } finally {
      setDashboardsLoaded(true);
    }
  }

  // Painel aberto em "Ver" mora na URL (?painel=<slug>): F5 mantém o painel,
  // o "voltar" do navegador fecha e o "avançar" reabre.
  const viewingDashboardSlug = searchParams.get('painel');
  const viewingDashboard = viewingDashboardSlug ? dashboards.find((d) => d.slug === viewingDashboardSlug) ?? null : null;

  function openDashboardViewer(slug: string) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'paineis');
    next.set('painel', slug);
    next.delete('pagina'); // abre sempre na página inicial do painel
    // Entrada nova no histórico; o marcador diz que o "fechar" pode simplesmente voltar uma entrada.
    setSearchParams(next, { state: { viewerFromList: true } });
  }

  function closeDashboardViewer() {
    if ((location.state as { viewerFromList?: boolean } | null)?.viewerFromList) {
      navigate(-1);
      return;
    }
    // Chegou direto pelo link/favorito: não há "lista" atrás no histórico.
    const next = new URLSearchParams(searchParams);
    next.delete('painel');
    next.delete('pagina');
    setSearchParams(next, { replace: true });
  }

  // Guarda na URL a página interna do painel (troca a entrada atual, não cria outra, e
  // preserva o marcador de "veio da lista" pro botão X continuar voltando uma entrada).
  const viewingPanelPath = parsePanelPath(searchParams.get('pagina'));
  function handlePanelPathChange(path: string) {
    if (searchParams.get('pagina') === path) return;
    const next = new URLSearchParams(searchParams);
    next.set('pagina', path);
    setSearchParams(next, { replace: true, state: location.state });
  }

  // A tela cheia (ou o "Carregando..." dela) já está montada: pode tirar a cobertura do index.html.
  useEffect(() => {
    if (viewingDashboardSlug || dashboardsLoaded) removeBootCover();
  }, [viewingDashboardSlug, dashboardsLoaded]);

  // Link para um painel que não existe (ou que a pessoa não pode ver): limpa o parâmetro.
  useEffect(() => {
    if (!viewingDashboardSlug || !dashboardsLoaded || viewingDashboard) return;
    const next = new URLSearchParams(searchParams);
    next.delete('painel');
    next.delete('pagina');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingDashboardSlug, dashboardsLoaded, viewingDashboard]);

  async function deleteDashboard(id: string) {
    setDeletingDashboardId(id);
    try {
      await api(`/dashboards/${id}`, { method: 'DELETE' });
      await loadDashboards();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir o painel.');
    } finally {
      setDeletingDashboardId(null);
    }
  }

  async function loadCredentials() {
    try {
      const data = await api<SharedCredential[]>('/shared-credentials');
      setCredentials(data);
    } catch {
      // silencioso — não bloqueia a página se falhar
    }
  }

  async function refreshBi(siteId: string) {
    if (requestingId) return;
    setRequestingId(siteId);
    try {
      await api(`/sites/${siteId}/powerbi-refresh`, { method: 'POST' });
      await loadSilent();
      setBiRefreshResults((prev) => ({ ...prev, [siteId]: 'ok' }));
      setTimeout(() => setBiRefreshResults((prev) => { const n = { ...prev }; delete n[siteId]; return n; }), 3000);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível solicitar a atualização.');
      setBiRefreshResults((prev) => ({ ...prev, [siteId]: 'error' }));
      setTimeout(() => setBiRefreshResults((prev) => { const n = { ...prev }; delete n[siteId]; return n; }), 3000);
    } finally {
      setRequestingId(null);
    }
  }

  async function openWithSso(site: Site) {
    try {
      const { token } = await api<{ token: string }>('/auth/sso');
      const url = `${site.url}/hub-sso/?token=${token}&hub=${window.location.origin}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      window.open(site.url, '_blank', 'noopener,noreferrer');
    }
  }

  useEffect(() => {
    if (!viewingSiteId) { setViewerIframeUrl(null); return; }
    const site = sites.find((s) => s.id === viewingSiteId);
    if (!site) return;
    if (!site.ssoEnabled) { setViewerIframeUrl(site.url); return; }
    setViewerIframeUrl(null);
    let cancelled = false;
    void api<{ token: string }>('/auth/sso').then(({ token }) => {
      if (!cancelled) setViewerIframeUrl(`${site.url}/hub-sso/?token=${token}&hub=${window.location.origin}`);
    }).catch(() => {
      if (!cancelled) setViewerIframeUrl(site.url);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingSiteId]);

  function openNewSiteForm(category: SiteCategory) {
    setSiteDraft(emptySiteDraft(category));
    setShowSiteForm(true);
  }

  function openEditSiteForm(site: Site) {
    setSiteDraft({
      id: site.id,
      name: site.name,
      url: site.url,
      description: site.description ?? '',
      category: site.category,
      maintenanceOverride: site.maintenanceOverride,
      allowedDepartments: site.allowedDepartments,
      minRole: site.minRole,
      powerbiGroupId: site.powerbiGroupId ?? '',
      powerbiDatasetId: site.powerbiDatasetId ?? '',
      powerbiScheduledTimes: site.powerbiScheduledTimes ?? [],
      powerbiShowRefresh: site.powerbiShowRefresh ?? true,
      ssoEnabled: site.ssoEnabled ?? false,
      linkedDashboardId: site.linkedDashboardId ?? '',
    });
    setShowSiteForm(true);
  }

  async function saveSite() {
    if (!siteDraft.name.trim() || !siteDraft.url.trim()) return;
    setSavingSite(true);
    try {
      await api<Site>('/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: siteDraft.id,
          name: siteDraft.name.trim(),
          url: siteDraft.url.trim(),
          description: siteDraft.description.trim() || null,
          category: siteDraft.category,
          maintenanceOverride: siteDraft.maintenanceOverride,
          allowedDepartments: siteDraft.allowedDepartments,
          minRole: siteDraft.minRole,
          powerbiGroupId: siteDraft.category === 'bi' ? siteDraft.powerbiGroupId.trim() : '',
          powerbiDatasetId: siteDraft.category === 'bi' ? siteDraft.powerbiDatasetId.trim() : '',
          powerbiScheduledTimes: siteDraft.category === 'bi' ? siteDraft.powerbiScheduledTimes.filter(Boolean) : [],
          powerbiShowRefresh: siteDraft.powerbiShowRefresh,
          ssoEnabled: siteDraft.ssoEnabled,
          linkedDashboardId: siteDraft.category === 'bi' ? siteDraft.linkedDashboardId || null : null,
        }),
      });
      await load();
      setShowSiteForm(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar o site.');
    } finally {
      setSavingSite(false);
    }
  }

  async function deleteSite(id: string) {
    setDeletingSiteId(id);
    try {
      await api(`/sites/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir o site.');
    } finally {
      setDeletingSiteId(null);
    }
  }

  function toggleReveal(id: string) {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function copyToClipboard(text: string, key: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(key);
      setTimeout(() => setCopiedId((prev) => (prev === key ? null : prev)), 1500);
    });
  }

  function openNewCredForm() {
    setEditingCred(null);
    setCredDraft(emptyDraft());
    setShowCredForm(true);
  }

  function openEditCredForm(cred: SharedCredential) {
    setEditingCred(cred);
    setCredDraft({
      name: cred.name,
      url: cred.url ?? '',
      login: cred.login,
      password: cred.password,
      notes: cred.notes ?? '',
      allowedDepartments: cred.allowedDepartments,
      minRole: cred.minRole,
    });
    setShowCredForm(true);
  }

  async function saveCred() {
    if (!credDraft.name.trim() || !credDraft.login.trim() || !credDraft.password.trim()) return;
    setSavingCred(true);
    try {
      const body = {
        name: credDraft.name.trim(),
        url: credDraft.url.trim() || null,
        login: credDraft.login.trim(),
        password: credDraft.password,
        notes: credDraft.notes.trim() || null,
        allowedDepartments: credDraft.allowedDepartments,
        minRole: credDraft.minRole,
      };
      if (editingCred) {
        await api(`/shared-credentials/${editingCred.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        await api('/shared-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      await loadCredentials();
      setShowCredForm(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar.');
    } finally {
      setSavingCred(false);
    }
  }

  async function deleteCred(id: string) {
    setDeletingCredId(id);
    try {
      await api(`/shared-credentials/${id}`, { method: 'DELETE' });
      await loadCredentials();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir.');
    } finally {
      setDeletingCredId(null);
    }
  }

  const sorted = useMemo(
    () => [...sites].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name, 'pt-BR')),
    [sites],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return sorted.filter((site) => {
      const matchesSearch = !term || site.name.toLowerCase().includes(term) || (site.description ?? '').toLowerCase().includes(term);
      return matchesSearch && site.category === (activeTab as SiteCategory);
    });
  }, [sorted, query, activeTab]);

  const filteredDashboards = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return dashboards;
    return dashboards.filter(
      (d) => d.name.toLowerCase().includes(term) || (d.description ?? '').toLowerCase().includes(term),
    );
  }, [dashboards, query]);

  const filteredCreds = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return credentials;
    return credentials.filter(
      (c) => c.name.toLowerCase().includes(term) || c.login.toLowerCase().includes(term) || (c.notes ?? '').toLowerCase().includes(term),
    );
  }, [credentials, query]);

  const viewingSite = sites.find((s) => s.id === viewingSiteId) ?? null;

  // BI aberto em "Ver" com painel vinculado: o chat do hub passa a responder
  // com os dados desse painel enquanto a visualização estiver aberta.
  const viewingLinkedSiteId = viewingSite?.linkedDashboardId ? viewingSite.id : null;
  const viewingLinkedDashboardId = viewingSite?.linkedDashboardId ?? null;
  const viewingLinkedSiteName = viewingSite?.name ?? '';
  useEffect(() => {
    if (!viewingLinkedSiteId || !viewingLinkedDashboardId) return;
    setBiScope({ siteId: viewingLinkedSiteId, name: viewingLinkedSiteName, conversationScope: `dash:${viewingLinkedDashboardId}` });
    return () => setBiScope(null);
  }, [viewingLinkedSiteId, viewingLinkedDashboardId, viewingLinkedSiteName, setBiScope]);

  useEffect(() => {
    if (!viewingSiteId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setViewingSiteId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewingSiteId]);

  useEffect(() => {
    if (!showSiteForm) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowSiteForm(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSiteForm]);

  useEffect(() => {
    if (!showCredForm) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowCredForm(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showCredForm]);

  const downCount = (activeTab === 'sistema' || activeTab === 'bi')
    ? sites.filter((s) => s.category === activeTab && s.status === 'down').length
    : activeTab === 'paineis'
      ? dashboards.filter((d) => (d.type === 'streamlit' || d.type === 'server') && !d.streamlitRunning).length
      : 0;
  const maintenanceCount = (activeTab === 'sistema' || activeTab === 'bi')
    ? sites.filter((s) => s.category === activeTab && s.status === 'maintenance').length
    : 0;

  // Tela cheia do painel (ou o "Carregando..." dela). Vale também enquanto a lista
  // de sites ainda carrega, senão o menu do hub aparece por trás num F5 com painel aberto.
  const dashboardOverlay =
    viewingDashboardSlug && viewingDashboard ? (
      <DashboardViewer
        dashboard={viewingDashboard}
        onClose={closeDashboardViewer}
        initialPath={viewingPanelPath}
        onPathChange={handlePanelPathChange}
      />
    ) : viewingDashboardSlug && !dashboardsLoaded ? (
      <PanelSkeleton />
    ) : null;

  if (loading) {
    return (
      <>
        <div role="status" aria-live="polite" className="grid grid-cols-1 animate-pulse gap-6">
          <div className="h-8 w-64 rounded-lg bg-slate-200 dark:bg-slate-800" />
          <div className="h-80 rounded-3xl bg-slate-100 dark:bg-slate-800/50" />
        </div>
        {dashboardOverlay}
      </>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Sites <span className="text-sky-600 dark:text-sky-400">da empresa</span></>}
        description="Status dos sistemas internos, atualizado automaticamente a cada poucos minutos."
      />

      {/* Tab bar */}
      <div className="flex gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1 dark:border-[#27272a] dark:bg-[#111113]">
        {SITE_CATEGORIES.map((category) => {
          const count = sites.filter((s) => s.category === category).length;
          const isActive = activeTab === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => setTab(category)}
              className={[
                'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
                isActive
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
                  : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
              ].join(' ')}
            >
              {siteCategoryLabel(category)}
              <span className={['rounded-full px-1.5 py-0.5 text-xs', isActive ? 'bg-slate-100 text-slate-600 dark:bg-[#27272a] dark:text-zinc-300' : 'bg-transparent text-slate-400 dark:text-zinc-500'].join(' ')}>
                {count}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setTab('paineis')}
          className={[
            'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
            activeTab === 'paineis'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
              : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
          ].join(' ')}
        >
          Painéis
          <span className={['rounded-full px-1.5 py-0.5 text-xs', activeTab === 'paineis' ? 'bg-slate-100 text-slate-600 dark:bg-[#27272a] dark:text-zinc-300' : 'bg-transparent text-slate-400 dark:text-zinc-500'].join(' ')}>
            {dashboards.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab('credenciais')}
          className={[
            'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
            activeTab === 'credenciais'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
              : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
          ].join(' ')}
        >
          Credenciais
          <span className={['rounded-full px-1.5 py-0.5 text-xs', activeTab === 'credenciais' ? 'bg-slate-100 text-slate-600 dark:bg-[#27272a] dark:text-zinc-300' : 'bg-transparent text-slate-400 dark:text-zinc-500'].join(' ')}>
            {credentials.length}
          </span>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-10 pl-9"
            placeholder={activeTab === 'bi' ? 'Buscar BI...' : activeTab === 'credenciais' ? 'Buscar credencial...' : activeTab === 'paineis' ? 'Buscar painel...' : 'Buscar site...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {isAdmin && activeTab === 'paineis' && (
          <Button size="sm" className="shrink-0" asChild>
            <Link to="/settings?tab=dashboards">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Adicionar
            </Link>
          </Button>
        )}
        {isAdmin && activeTab !== 'paineis' && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              if (activeTab === 'credenciais') openNewCredForm();
              else openNewSiteForm(activeTab as SiteCategory);
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Adicionar
          </Button>
        )}
      </div>

      {(downCount > 0 || maintenanceCount > 0) ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-zinc-400">
          <span>Precisa de atenção:</span>
          {downCount > 0 ? <Badge variant="danger">{downCount} fora do ar</Badge> : null}
          {maintenanceCount > 0 ? <Badge variant="warning">{maintenanceCount} em manutenção</Badge> : null}
        </div>
      ) : null}

      {viewingSite ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-[#0a0a0b]">
          <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-[#2b2b31] dark:bg-[#111113]">
            <SiteFavicon siteId={viewingSite.id} />
            <span className="flex-1 truncate font-medium text-slate-900 dark:text-white">{viewingSite.name}</span>
            {viewingSite.ssoEnabled ? (
              <Button variant="outline" size="sm" onClick={() => void openWithSso(viewingSite)}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Abrir em nova aba
              </Button>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <a href={viewingSite.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Abrir em nova aba
                </a>
              </Button>
            )}
            <button
              type="button"
              aria-label="Fechar visualização"
              onClick={() => setViewingSiteId(null)}
              className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-[#1b1b20]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {viewerIframeUrl ? (
            <iframe src={viewerIframeUrl} title={viewingSite.name} className="flex-1 border-0" allow="fullscreen" />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400 dark:text-zinc-500">Carregando...</div>
          )}
        </div>
      ) : null}

      {dashboardOverlay}

      {/* Site form overlay */}
      {showSiteForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl dark:bg-[#111113] max-h-[min(90vh,calc(100dvh-2rem))] flex flex-col my-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-[#27272a] shrink-0">
              <h2 className="font-semibold text-slate-900 dark:text-white">
                {siteDraft.id ? 'Editar site' : siteDraft.category === 'bi' ? 'Novo BI' : 'Novo site'}
              </h2>
              <button type="button" onClick={() => setShowSiteForm(false)} className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-[#1b1b20]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-4 px-5 py-5 overflow-y-auto">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5 col-span-2">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Nome *</label>
                  <Input placeholder="Ex: Domínio Contábil" value={siteDraft.name} onChange={(e) => setSiteDraft((d) => ({ ...d, name: e.target.value }))} />
                </div>
                <div className="grid gap-1.5 col-span-2">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">URL *</label>
                  <Input placeholder="https://..." value={siteDraft.url} onChange={(e) => setSiteDraft((d) => ({ ...d, url: e.target.value }))} />
                </div>
                <div className="grid gap-1.5 col-span-2">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Descrição (opcional)</label>
                  <Input placeholder="Ex: Sistema de folha de pagamento" value={siteDraft.description} onChange={(e) => setSiteDraft((d) => ({ ...d, description: e.target.value }))} />
                </div>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Status</label>
                <button
                  type="button"
                  onClick={() => setSiteDraft((d) => ({ ...d, maintenanceOverride: !d.maintenanceOverride }))}
                  className={['flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition w-fit', siteDraft.maintenanceOverride ? 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500/50 dark:bg-amber-900/20 dark:text-amber-300' : 'border-slate-200 text-slate-500 dark:border-[#27272a] dark:text-zinc-400'].join(' ')}
                >
                  <span className={['h-2 w-2 rounded-full', siteDraft.maintenanceOverride ? 'bg-amber-500' : 'bg-emerald-500'].join(' ')} />
                  {siteDraft.maintenanceOverride ? 'Em manutenção' : 'Online'}
                </button>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Visibilidade</label>
                <div className="flex gap-2">
                  {(['employee', 'manager'] as const).map((role) => (
                    <button key={role} type="button" onClick={() => setSiteDraft((d) => ({ ...d, minRole: role }))} className={['flex-1 rounded-xl border px-3 py-2 text-sm font-medium transition', siteDraft.minRole === role ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-900/30 dark:text-sky-300' : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-[#27272a] dark:text-zinc-400'].join(' ')}>
                      {role === 'employee' ? 'Gestores e funcionários' : 'Somente gestores'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
                  Departamentos com acesso
                  <span className="ml-1 font-normal text-slate-400">(vazio = todos)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {departments.map((dept) => {
                    const selected = siteDraft.allowedDepartments.includes(dept.slug);
                    return (
                      <button key={dept.slug} type="button" onClick={() => setSiteDraft((d) => ({ ...d, allowedDepartments: selected ? d.allowedDepartments.filter((s) => s !== dept.slug) : [...d.allowedDepartments, dept.slug] }))} className={['rounded-full border px-3 py-1 text-xs font-medium transition', selected ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-900/30 dark:text-sky-300' : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-[#27272a] dark:text-zinc-400'].join(' ')}>
                        {dept.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSiteDraft((d) => ({ ...d, ssoEnabled: !d.ssoEnabled }))}
                className={['flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition w-fit', siteDraft.ssoEnabled ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-900/30 dark:text-sky-300' : 'border-slate-200 text-slate-500 dark:border-[#27272a] dark:text-zinc-400'].join(' ')}
              >
                {siteDraft.ssoEnabled ? '✓ Login automático via Hub ativado' : 'Login automático via Hub'}
              </button>

              {siteDraft.category === 'bi' && (
                <div className="grid gap-1.5 rounded-xl border border-slate-200 p-3 dark:border-[#27272a]">
                  <label htmlFor="site-linked-dashboard" className="text-xs font-semibold text-slate-500 dark:text-zinc-400">
                    Chat de IA (painel vinculado)
                  </label>
                  <select
                    id="site-linked-dashboard"
                    className="flex h-10 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
                    value={siteDraft.linkedDashboardId}
                    onChange={(e) => setSiteDraft((d) => ({ ...d, linkedDashboardId: e.target.value }))}
                  >
                    <option value="">Nenhum (chat normal do hub)</option>
                    {dashboards
                      .filter((d) => d.type === 'server' || d.id === siteDraft.linkedDashboardId)
                      .map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                  </select>
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Com um painel escolhido, ao abrir este BI em &quot;Ver&quot; o chat do hub responde as perguntas usando os dados do painel.
                  </p>
                </div>
              )}

              {siteDraft.category === 'bi' && (
                <div className="grid gap-3 rounded-xl border border-slate-200 p-3 dark:border-[#27272a]">
                  <p className="text-xs font-semibold text-slate-500 dark:text-zinc-400">Power BI</p>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Group ID (Workspace)</label>
                    <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={siteDraft.powerbiGroupId} onChange={(e) => setSiteDraft((d) => ({ ...d, powerbiGroupId: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Dataset ID</label>
                    <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={siteDraft.powerbiDatasetId} onChange={(e) => setSiteDraft((d) => ({ ...d, powerbiDatasetId: e.target.value }))} />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Horários de atualização automática</label>
                    <div className="flex flex-col gap-1.5">
                      {siteDraft.powerbiScheduledTimes.map((t, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={t}
                            onChange={(e) => setSiteDraft((d) => ({
                              ...d,
                              powerbiScheduledTimes: d.powerbiScheduledTimes.map((x, j) => j === i ? e.target.value : x),
                            }))}
                            className="w-32"
                          />
                          <button
                            type="button"
                            onClick={() => setSiteDraft((d) => ({
                              ...d,
                              powerbiScheduledTimes: d.powerbiScheduledTimes.filter((_, j) => j !== i),
                            }))}
                            className="rounded-lg p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setSiteDraft((d) => ({ ...d, powerbiScheduledTimes: [...d.powerbiScheduledTimes, '08:00'] }))}
                        className="flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        <Plus className="h-3 w-3" />
                        Adicionar horário
                      </button>
                    </div>
                  </div>
                  <button type="button" onClick={() => setSiteDraft((d) => ({ ...d, powerbiShowRefresh: !d.powerbiShowRefresh }))} className={['flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition w-fit', siteDraft.powerbiShowRefresh ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-900/30 dark:text-sky-300' : 'border-slate-200 text-slate-500 dark:border-[#27272a] dark:text-zinc-400'].join(' ')}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    {siteDraft.powerbiShowRefresh ? 'Mostrar botão de atualizar' : 'Ocultar botão de atualizar'}
                  </button>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-[#27272a] shrink-0">
              <Button variant="outline" size="sm" onClick={() => setShowSiteForm(false)}>Cancelar</Button>
              <Button size="sm" disabled={savingSite || !siteDraft.name.trim() || !siteDraft.url.trim()} onClick={() => void saveSite()}>
                {savingSite ? 'Salvando...' : siteDraft.id ? 'Salvar alterações' : 'Criar site'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Credential form overlay */}
      {showCredForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl dark:bg-[#111113] max-h-[min(90vh,calc(100dvh-2rem))] flex flex-col my-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-[#27272a] shrink-0">
              <h2 className="font-semibold text-slate-900 dark:text-white">
                {editingCred ? 'Editar credencial' : 'Nova credencial'}
              </h2>
              <button
                type="button"
                onClick={() => setShowCredForm(false)}
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-[#1b1b20]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-4 px-5 py-5 overflow-y-auto">
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Nome do site *</label>
                <Input
                  placeholder="Ex: Domínio Sistemas"
                  value={credDraft.name}
                  onChange={(e) => setCredDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">URL (opcional)</label>
                <Input
                  placeholder="https://..."
                  value={credDraft.url}
                  onChange={(e) => setCredDraft((d) => ({ ...d, url: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Login *</label>
                  <Input
                    placeholder="usuário"
                    value={credDraft.login}
                    onChange={(e) => setCredDraft((d) => ({ ...d, login: e.target.value }))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Senha *</label>
                  <Input
                    placeholder="senha"
                    value={credDraft.password}
                    onChange={(e) => setCredDraft((d) => ({ ...d, password: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Observações (opcional)</label>
                <Input
                  placeholder="Ex: usar apenas para notas fiscais"
                  value={credDraft.notes}
                  onChange={(e) => setCredDraft((d) => ({ ...d, notes: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">Visibilidade</label>
                <div className="flex gap-2">
                  {(['employee', 'manager'] as const).map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setCredDraft((d) => ({ ...d, minRole: role }))}
                      className={[
                        'flex-1 rounded-xl border px-3 py-2 text-sm font-medium transition',
                        credDraft.minRole === role
                          ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-900/30 dark:text-sky-300'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-[#27272a] dark:text-zinc-400',
                      ].join(' ')}
                    >
                      {role === 'employee' ? 'Gestores e funcionários' : 'Somente gestores'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
                  Departamentos com acesso
                  <span className="ml-1 font-normal text-slate-400">(vazio = todos)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {departments.map((dept) => {
                    const selected = credDraft.allowedDepartments.includes(dept.slug);
                    return (
                      <button
                        key={dept.slug}
                        type="button"
                        onClick={() =>
                          setCredDraft((d) => ({
                            ...d,
                            allowedDepartments: selected
                              ? d.allowedDepartments.filter((s) => s !== dept.slug)
                              : [...d.allowedDepartments, dept.slug],
                          }))
                        }
                        className={[
                          'rounded-full border px-3 py-1 text-xs font-medium transition',
                          selected
                            ? 'border-sky-500 bg-sky-50 text-sky-700 dark:border-sky-400 dark:bg-sky-900/30 dark:text-sky-300'
                            : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-[#27272a] dark:text-zinc-400',
                        ].join(' ')}
                      >
                        {dept.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-[#27272a] shrink-0">
              <Button variant="outline" size="sm" onClick={() => setShowCredForm(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                disabled={savingCred || !credDraft.name.trim() || !credDraft.login.trim() || !credDraft.password.trim()}
                onClick={() => void saveCred()}
              >
                {savingCred ? 'Salvando...' : editingCred ? 'Salvar alterações' : 'Criar credencial'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Card className="overflow-hidden rounded-3xl">
        <CardContent className="px-0 pb-0 pt-1">
          {activeTab === 'credenciais' ? (
            filteredCreds.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Site</TableHead>
                      <TableHead className="w-40">Login</TableHead>
                      <TableHead className="w-48">Senha</TableHead>
                      <TableHead>Observações</TableHead>
                      <TableHead>Departamentos</TableHead>
                      {isAdmin && <TableHead className="w-px whitespace-nowrap" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredCreds.map((cred) => {
                      const revealed = revealedIds.has(cred.id);
                      const loginKey = `login-${cred.id}`;
                      const passKey = `pass-${cred.id}`;
                      return (
                        <TableRow key={cred.id}>
                          <TableCell>
                            <div className="min-w-0">
                              <div className="font-medium text-slate-950 dark:text-white">{cred.name}</div>
                              {cred.url ? (
                                <a
                                  href={cred.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-xs text-sky-600 hover:underline dark:text-sky-400"
                                >
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                  Abrir
                                </a>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <span className="font-mono text-sm text-slate-700 dark:text-zinc-300">{cred.login}</span>
                              <button
                                type="button"
                                title="Copiar login"
                                onClick={() => copyToClipboard(cred.login, loginKey)}
                                className="ml-1 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-[#1b1b20] dark:hover:text-zinc-200"
                              >
                                {copiedId === loginKey ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <span className="font-mono text-sm text-slate-700 dark:text-zinc-300">
                                {revealed ? cred.password : '••••••••'}
                              </span>
                              <button
                                type="button"
                                title={revealed ? 'Ocultar senha' : 'Revelar senha'}
                                onClick={() => toggleReveal(cred.id)}
                                className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-[#1b1b20] dark:hover:text-zinc-200"
                              >
                                {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </button>
                              <button
                                type="button"
                                title="Copiar senha"
                                onClick={() => copyToClipboard(cred.password, passKey)}
                                className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-[#1b1b20] dark:hover:text-zinc-200"
                              >
                                {copiedId === passKey ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-slate-500 dark:text-zinc-400">{cred.notes ?? '—'}</span>
                          </TableCell>
                          <TableCell>
                            {cred.allowedDepartments.length === 0 ? (
                              <span className="text-xs text-slate-400 dark:text-zinc-500">Todos</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {cred.allowedDepartments.map((d) => (
                                  <Badge key={d} variant="muted">{departmentLabel(d, departments)}</Badge>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          {isAdmin && (
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  title="Editar"
                                  onClick={() => openEditCredForm(cred)}
                                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-[#1b1b20] dark:hover:text-zinc-200"
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  title="Excluir"
                                  disabled={deletingCredId === cred.id}
                                  onClick={() => void deleteCred(cred.id)}
                                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-40 dark:hover:bg-red-900/20"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-slate-500 dark:text-zinc-400">
                {query ? `Nenhuma credencial encontrada para "${query}".` : isAdmin ? 'Nenhuma credencial cadastrada. Clique em "Adicionar" para começar.' : 'Nenhuma credencial disponível para o seu departamento.'}
              </p>
            )
          ) : activeTab === 'paineis' ? (
            filteredDashboards.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead className="w-40">Status</TableHead>
                      <TableHead>Última atualização</TableHead>
                      <TableHead className="w-px whitespace-nowrap" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDashboards.map((d) => {
                      const isProcess = d.type === 'streamlit' || d.type === 'server';
                      const isDown = isProcess && !d.streamlitRunning;
                      const dashStatus: SiteStatus = isDown ? 'down' : 'online';
                      return (
                        <TableRow key={d.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600 dark:bg-sky-900/20 dark:text-sky-400">
                                {d.type === 'server' ? <Server className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium text-slate-950 dark:text-white">{d.name}</div>
                                {d.description ? (
                                  <div className="text-xs text-slate-500 dark:text-zinc-400">{d.description}</div>
                                ) : null}
                                {d.updateFrequency && d.updateTimesOfDay && d.updateTimesOfDay.length > 0 && (
                                  <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-400 dark:text-zinc-500">
                                    <Clock className="h-3 w-3 shrink-0" />
                                    <span>Atualiza às {d.updateTimesOfDay.join(', ')}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            {d.type === 'html' ? (
                              <Badge variant="muted">Estático</Badge>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <StatusDot status={dashStatus} />
                                <span className="text-slate-600 dark:text-zinc-300">{siteStatusLabel(dashStatus)}</span>
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {d.updatePath ? (
                              <DashboardStatusBadge status={d.lastUpdateStatus} lastUpdateAt={d.lastUpdateAt} />
                            ) : (
                              <span className="text-sm text-slate-400 dark:text-zinc-500">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              {d.updatePath ? (
                                <DashboardUpdateBtn
                                  id={d.id}
                                  onDone={(status) => setDashboards((prev) => prev.map((x) => x.id === d.id ? { ...x, lastUpdateStatus: status, lastUpdateAt: new Date().toISOString() } : x))}
                                />
                              ) : null}
                              <Button variant="outline" size="sm" disabled={isDown} onClick={() => openDashboardViewer(d.slug)}>
                                Abrir
                              </Button>
                              {isAdmin && (
                                <>
                                  <Link
                                    to={`/settings?tab=dashboards&dashboardId=${d.id}`}
                                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-[#1b1b20] dark:hover:text-zinc-200"
                                    title="Editar"
                                  >
                                    <Edit2 className="h-3.5 w-3.5" />
                                  </Link>
                                  <button type="button" disabled={deletingDashboardId === d.id} onClick={() => void deleteDashboard(d.id)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-red-900/20 dark:hover:text-red-400" title="Apagar">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-slate-500 dark:text-zinc-400">
                {query ? `Nenhum painel encontrado para "${query}".` : isAdmin ? 'Nenhum painel cadastrado. Clique em "Adicionar" para começar.' : 'Nenhum painel disponível para o seu departamento.'}
              </p>
            )
          ) : filtered.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead className="w-40">Status</TableHead>
                    {activeTab === 'bi' && <TableHead>Última atualização</TableHead>}
                    <TableHead className="w-px whitespace-nowrap" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((site) => {
                    const isPending = isPowerBIRefreshPending(site.powerbiRefreshStatus);
                    const isRequesting = requestingId === site.id;
                    const hasDataset = activeTab === 'bi' && Boolean(site.powerbiDatasetId);
                    const showRefreshBtn = hasDataset && site.powerbiShowRefresh !== false;
                    const scheduledTimes = activeTab === 'bi' ? site.powerbiScheduledTimes : null;
                    return (
                      <TableRow key={site.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <SiteFavicon siteId={site.id} />
                            <div className="min-w-0">
                              <div className="font-medium text-slate-950 dark:text-white">{site.name}</div>
                              {scheduledTimes && scheduledTimes.length > 0 ? (
                                <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-400 dark:text-zinc-500">
                                  <Clock className="h-3 w-3 shrink-0" />
                                  <span>Atualiza às {scheduledTimes.join(', ')}</span>
                                </div>
                              ) : site.description ? (
                                <div className="text-xs text-slate-500 dark:text-zinc-400">{site.description}</div>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <StatusDot status={site.status} />
                            <span className="text-slate-600 dark:text-zinc-300">{siteStatusLabel(site.status)}</span>
                          </div>
                        </TableCell>
                        {activeTab === 'bi' && (
                          <TableCell>
                            <PowerBIStatusBadge status={site.powerbiRefreshStatus} lastRefreshAt={site.powerbiLastRefreshAt} visible={hasDataset} />
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            {showRefreshBtn ? (
                              <RefreshIconButton
                                onClick={() => void refreshBi(site.id)}
                                pending={isRequesting || isPending}
                                result={biRefreshResults[site.id] ?? null}
                                title={isPending ? 'Atualizando...' : 'Atualizar dados'}
                              />
                            ) : null}
                            <Button variant="outline" size="sm" onClick={() => setViewingSiteId(site.id)}>
                              Ver
                            </Button>
                            {site.ssoEnabled ? (
                              <Button variant="outline" size="sm" onClick={() => void openWithSso(site)}>
                                Abrir
                                <ExternalLink className="ml-2 h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Button variant="outline" size="sm" asChild>
                                <a href={site.url} target="_blank" rel="noopener noreferrer">
                                  Abrir
                                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                                </a>
                              </Button>
                            )}
                            {isAdmin && (
                              <>
                                <button type="button" onClick={() => openEditSiteForm(site)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-[#1b1b20] dark:hover:text-zinc-200" title="Editar">
                                  <Edit2 className="h-3.5 w-3.5" />
                                </button>
                                <button type="button" disabled={deletingSiteId === site.id} onClick={() => void deleteSite(site.id)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-red-900/20 dark:hover:text-red-400" title="Apagar">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="px-5 py-6 text-sm text-slate-500 dark:text-zinc-400">
              {query ? `Nenhum site encontrado para "${query}".` : 'Nenhum site cadastrado ainda.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DashboardStatusBadge({ status, lastUpdateAt }: { status?: string | null; lastUpdateAt?: string | null }) {
  if (status === 'running') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-600 dark:bg-sky-900/20 dark:text-sky-400">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
        Atualizando...
      </span>
    );
  }
  if (status === 'ok' && lastUpdateAt) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
        Atualizado {timeAgo(lastUpdateAt)}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        title="Ocorreu um erro ao atualizar os dados do painel."
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-900/20 dark:text-red-400"
      >
        Falha na atualização
      </span>
    );
  }
  return null;
}

// Botão de ícone único para "atualizar dados" — usado por Painéis e por BI/Power BI,
// para que a mesma ação pareça exatamente a mesma em qualquer aba.
function RefreshIconButton({
  onClick,
  pending,
  result,
  title,
}: {
  onClick: () => void;
  pending: boolean;
  result: 'ok' | 'error' | null;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={pending}
      title={title}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
    >
      {pending ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      ) : result === 'ok' ? (
        <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
      ) : result === 'error' ? (
        <AlertCircle className="h-3.5 w-3.5 text-red-500" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function DashboardUpdateBtn({ id, onDone }: { id: string; onDone: (status: 'ok' | 'error') => void }) {
  const { notify } = useHub();
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<'ok' | 'error' | null>(null);

  async function handleClick() {
    if (updating) return;
    setUpdating(true);
    setResult(null);
    try {
      await api(`/dashboards/${id}/update`, { method: 'POST' });
      notify('Painel atualizado com sucesso.');
      setResult('ok');
      onDone('ok');
    } catch {
      setResult('error');
      onDone('error');
    } finally {
      setUpdating(false);
      setTimeout(() => setResult(null), 3000);
    }
  }

  return (
    <RefreshIconButton
      onClick={() => void handleClick()}
      pending={updating}
      result={result}
      title="Atualizar dados do painel"
    />
  );
}

function PowerBIStatusBadge({ status, lastRefreshAt, visible }: { status?: string | null; lastRefreshAt?: string | null; visible: boolean }) {
  if (!visible) return null;
  if (status === 'Unknown' || status === 'InProgress') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-600 dark:bg-sky-900/20 dark:text-sky-400">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
        Atualizando...
      </span>
    );
  }
  if (status === 'Completed' && lastRefreshAt) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
        Atualizado {timeAgo(lastRefreshAt)}
      </span>
    );
  }
  if (status === 'Failed') {
    return (
      <span
        title="Ocorreu um erro ao atualizar os dados. Entre em contato com o departamento de Inovação."
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-900/20 dark:text-red-400"
      >
        Falha na atualização
      </span>
    );
  }
  return null;
}
