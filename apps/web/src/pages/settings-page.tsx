import { Bot, Building2, Clock, ClipboardCopy, Code2, Eye, EyeOff, FolderOpen, Globe, LayoutGrid, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Field } from '../components/field';
import { PageHeader } from '../components/page-header';
import { SiteFavicon } from '../components/site-favicon';
import { StatusDot } from '../components/status-dot';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Separator } from '../components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { ROLE_LABELS } from '../lib/constants';
import { api, downloadWithFeedback } from '../lib/api';
import type {
  Dashboard,
  Department,
  DepartmentConfig,
  DashboardType,
  DevDoc,
  IgnoredIdentity,
  ManagedUser,
  Robot,
  RobotInputExample,
  RobotSchemaField,
  RobotSchemaFileInput,
  Site,
  SiteCategory,
  UnlinkedExternalIdentity,
  UserRole,
} from '../lib/types';
import { departmentLabel, formatSecondsToHuman, siteCategoryLabel, siteStatusLabel, siteStatusVariant, timeAgo, userFileName } from '../lib/utils';

type Draft = {
  id?: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  icon: string;
  isActive: boolean;
  version: string;
  maxConcurrency: string;
  manualSecondsPerUnit: string;
  unitLabel: string;
  unitMetricKey: string;
  conflictKeys: string;
  zipOutput: boolean;
  isExternal: boolean;
  command: string;
  workingDirectory: string;
  scriptFileName: string;
  allowedDepartments: Department[];
  documentationUrl: string;
  documentationLabel: string;
  supportLabel: string;
  supportValue: string;
  dataPolicy: string;
  fields: RobotSchemaField[];
  fileInputs: RobotSchemaFileInput[];
};

type DashboardDraft = {
  id?: string;
  name: string;
  slug: string;
  description: string;
  type: DashboardType;
  isActive: boolean;
  allowedDepartments: Department[];
  minRole: UserRole;
  allowedUserIds: string[];
  restrictToUsers: boolean;
  mainFile: string;
  serverCommand: string;
  serverWorkingDirectory: string;
  updatePath: string;
  warmupPaths: string;
  warmupMode: 'disabled' | 'manual' | 'auto';
  updateFrequency: string;
  updateTimesOfDay: string[];
  updateDayOfWeek: string;
  updateDayOfMonth: string;
};

type SiteDraft = {
  id?: string;
  name: string;
  url: string;
  description: string;
  category: SiteCategory;
  maintenanceOverride: boolean;
  allowedDepartments: Department[];
  minRole: 'employee' | 'manager';
  powerbiGroupId: string;
  powerbiDatasetId: string;
  powerbiScheduledTimes: string[];
  powerbiShowRefresh: boolean;
  ssoEnabled: boolean;
};

type UserDraft = {
  name: string;
  password: string;
  role: UserRole;
  departments: Department[];
  isActive: boolean;
};

type NewUserDraft = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  departments: Department[];
};

function emptyNewUserDraft(): NewUserDraft {
  return { name: '', email: '', password: '', role: 'employee', departments: [] };
}

export function SettingsPage() {
  const { user } = useAuth();
  const { hub, hubError, notify, refreshHub, departments, refreshDepartments } = useHub();
  const [query, setQuery] = useState('');
  const robots = hub?.robots ?? [];
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const VALID_TABS = ['robots', 'users', 'sites', 'dashboards', 'departments', 'sistema', 'docs'] as const;
  type Tab = typeof VALID_TABS[number];
  const rawTab = searchParams.get('tab');
  const activeTab: Tab = (VALID_TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'robots';
  function setActiveTab(tab: Tab) {
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('tab', tab); return next; });
  }
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [isCreatingNewSite, setIsCreatingNewSite] = useState(false);
  const [siteDraft, setSiteDraft] = useState<SiteDraft>(emptySiteDraft());
  const [isSavingSite, setIsSavingSite] = useState(false);
  const [isCheckingSite, setIsCheckingSite] = useState(false);
  const [faviconFile, setFaviconFile] = useState<File | null>(null);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const [faviconVersion, setFaviconVersion] = useState(0);
  const [exampleFile, setExampleFile] = useState<File | null>(null);
  const [exampleInputName, setExampleInputName] = useState('');
  const [exampleTitle, setExampleTitle] = useState('');
  const [exampleDescription, setExampleDescription] = useState('');
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [scriptEntryScript, setScriptEntryScript] = useState('');
  const [pipStatus, setPipStatus] = useState<'installing' | 'done' | 'error' | null>(null);
  const [isSavingRobot, setIsSavingRobot] = useState(false);
  const [isManagingApiKey, setIsManagingApiKey] = useState(false);
  const [generatedApiKey, setGeneratedApiKey] = useState<string | null>(null);
  const pipPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [closingUserId, setClosingUserId] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState<UserDraft | null>(null);
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [isCreatingNewUser, setIsCreatingNewUser] = useState(false);
  const [confirmDeleteRobotId, setConfirmDeleteRobotId] = useState<string | null>(null);
  const [confirmDeleteSiteId, setConfirmDeleteSiteId] = useState<string | null>(null);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [deptDraft, setDeptDraft] = useState({ name: '', slug: '' });
  const [isSavingDept, setIsSavingDept] = useState(false);
  const [confirmDeleteDeptId, setConfirmDeleteDeptId] = useState<string | null>(null);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [selectedDashboardId, setSelectedDashboardId] = useState<string | null>(null);
  const [isCreatingNewDashboard, setIsCreatingNewDashboard] = useState(false);
  const [dashboardDraft, setDashboardDraft] = useState<DashboardDraft>(emptyDashboardDraft());
  const [isSavingDashboard, setIsSavingDashboard] = useState(false);
  const [dashboardFile, setDashboardFile] = useState<File | null>(null);
  const [confirmDeleteDashboardId, setConfirmDeleteDashboardId] = useState<string | null>(null);
  const [dashboardAction, setDashboardAction] = useState<'start' | 'stop' | null>(null);
  const [dashboardLog, setDashboardLog] = useState<string[]>([]);

  // Dev Docs state
  const [docs, setDocs] = useState<DevDoc[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [isCreatingNewDoc, setIsCreatingNewDoc] = useState(false);
  const [isSavingDoc, setIsSavingDoc] = useState(false);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);

  type DocDraft = {
    title: string; category: string; summary: string; howToUse: string;
    codeExample: string; language: string; endpoint: string; tags: string; order: string;
  };
  function emptyDocDraft(): DocDraft {
    return { title: '', category: '', summary: '', howToUse: '', codeExample: '', language: '', endpoint: '', tags: '', order: '' };
  }
  function docToDraft(d: DevDoc): DocDraft {
    return { title: d.title, category: d.category, summary: d.summary, howToUse: d.howToUse,
      codeExample: d.codeExample ?? '', language: d.language ?? '', endpoint: d.endpoint ?? '',
      tags: d.tags.join(', '), order: String(d.order) };
  }
  const [docDraft, setDocDraft] = useState<DocDraft>(emptyDocDraft());

  async function loadDocs() {
    try { setDocs(await api<DevDoc[]>('/dev-docs')); } catch { /* silently ignore */ }
  }

  type SystemSettings = { runnerMaxConcurrency: number; runnerMemoryThreshold: number; executionRetentionDays: number; executionRetentionDaysWithOutput: number };
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [isSavingSystem, setIsSavingSystem] = useState(false);
  const [storageMb, setStorageMb] = useState<number | null>(null);
  const [isSweeping, setIsSweeping] = useState(false);

  type SyncStatusData = {
    configured: boolean;
    syncing: boolean;
    lastSyncStatus: string;
    lastSyncAt: string | null;
    lastSyncOutput: string;
  };
  const [syncStatus, setSyncStatus] = useState<SyncStatusData | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  async function loadSystemSettings() {
    try {
      const data = await api<SystemSettings>('/system/settings');
      setSystemSettings(data);
    } catch { /* silently ignore */ }
    try {
      const { mb } = await api<{ mb: number }>('/system/storage-size');
      setStorageMb(mb);
    } catch { /* silently ignore */ }
  }

  async function triggerSweep() {
    setIsSweeping(true);
    try {
      await api('/system/sweep', { method: 'POST' });
      notify('Limpeza iniciada — pode levar alguns segundos.');
      setTimeout(() => {
        void api<{ mb: number }>('/system/storage-size').then(({ mb }) => setStorageMb(mb)).catch(() => null);
      }, 5000);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Erro ao iniciar limpeza.');
    } finally {
      setIsSweeping(false);
    }
  }

  async function saveSystemSettings(patch: Partial<SystemSettings>) {
    setIsSavingSystem(true);
    try {
      const updated = await api<SystemSettings>('/system/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      setSystemSettings(updated);
      notify('Configurações salvas.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Erro ao salvar configurações.');
    } finally {
      setIsSavingSystem(false);
    }
  }

  useEffect(() => {
    void loadUsers();
    void loadSites();
    void loadDashboards();
    void loadSyncStatus();
    void loadSystemSettings();
    void loadDocs();
  }, []);

  const sitesRef = useRef(sites);
  sitesRef.current = sites;
  useEffect(() => {
    const site = sitesRef.current.find((item) => item.id === selectedSiteId);
    setSiteDraft(site ? mapSiteToDraft(site) : emptySiteDraft());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSiteId]);

  useEffect(() => {
    if (selectedSiteId) {
      setIsCreatingNewSite(false);
    }
  }, [selectedSiteId]);

  useEffect(() => {
    setQuery('');
    if (activeTab !== 'departments') setSelectedDeptId(null);
    if (activeTab !== 'dashboards') { setSelectedDashboardId(null); setIsCreatingNewDashboard(false); }
    if (activeTab !== 'docs') { setSelectedDocId(null); setIsCreatingNewDoc(false); }
  }, [activeTab]);

  // Deep-link de "Editar" na aba Painéis (Sites): /settings?tab=dashboards&dashboardId=<id>
  useEffect(() => {
    if (activeTab !== 'dashboards') return;
    const id = searchParams.get('dashboardId');
    if (id) setSelectedDashboardId(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, searchParams]);

  useEffect(() => {
    if (isCreatingNewDoc) { setDocDraft(emptyDocDraft()); return; }
    const doc = docs.find((d) => d.id === selectedDocId);
    setDocDraft(doc ? docToDraft(doc) : emptyDocDraft());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocId, isCreatingNewDoc, docs]);

  useEffect(() => {
    if (!selectedDeptId || selectedDeptId === 'new') {
      setDeptDraft({ name: '', slug: '' });
      return;
    }
    const dept = departments.find((d) => d.id === selectedDeptId);
    if (dept) setDeptDraft({ name: dept.name, slug: dept.slug });
  }, [selectedDeptId, departments]);

  useEffect(() => {
    setFaviconFile(null);
  }, [selectedSiteId]);

  useEffect(() => {
    const d = dashboards.find((item) => item.id === selectedDashboardId);
    setDashboardDraft(d ? mapDashboardToDraft(d) : emptyDashboardDraft());
    setDashboardFile(null);
  }, [selectedDashboardId, dashboards]);


  // Interpolação do pip-status não pode sobreviver ao unmount da página
  useEffect(() => {
    return () => {
      if (pipPollRef.current) clearInterval(pipPollRef.current);
    };
  }, []);


  const robotsRef = useRef(robots);
  robotsRef.current = robots;
  useEffect(() => {
    const robot = robotsRef.current.find((item) => item.id === selectedRobotId);
    setDraft(robot ? mapRobotToDraft(robot) : emptyDraft());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRobotId]);

  useEffect(() => {
    setExampleFile(null);
    setExampleInputName('');
    setExampleTitle('');
    setExampleDescription('');
    setScriptFile(null);
    setScriptEntryScript('');
    setGeneratedApiKey(null);
  }, [selectedRobotId]);

  useEffect(() => {
    if (selectedRobotId) {
      setIsCreatingNew(false);
    }
  }, [selectedRobotId]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [sites, selectedSiteId],
  );

  const selectedRobot = useMemo(
    () => robots.find((robot) => robot.id === selectedRobotId) ?? null,
    [robots, selectedRobotId],
  );
  const filteredRobots = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return robots;
    return robots.filter(
      (r) =>
        r.name.toLowerCase().includes(term) ||
        (r.category ?? '').toLowerCase().includes(term) ||
        (r.summary ?? '').toLowerCase().includes(term),
    );
  }, [robots, query]);

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term) ||
        ROLE_LABELS[u.role].toLowerCase().includes(term) ||
        u.departments.some((d) => departmentLabel(d, departments).toLowerCase().includes(term)),
    );
  }, [users, query]);

  const filteredSites = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return sites;
    return sites.filter(
      (s) =>
        s.name.toLowerCase().includes(term) ||
        (s.description ?? '').toLowerCase().includes(term),
    );
  }, [sites, query]);

  async function loadSites() {
    try {
      const data = await api<Site[]>('/sites');
      setSites(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar os sites.');
    }
  }

  async function loadDashboards() {
    try {
      const data = await api<Dashboard[]>('/dashboards');
      setDashboards(data);
    } catch { /* silently ignore */ }
  }

  async function fetchDashboardLog(id: string) {
    try {
      const { lastLog } = await api<{ running: boolean; streamlitStatus: string; lastLog: string[] }>(`/dashboards/${id}/status`);
      setDashboardLog(lastLog ?? []);
    } catch { setDashboardLog([]); }
  }

  async function loadUsers() {
    try {
      const data = await api<ManagedUser[]>('/users');
      setUsers(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar os usuários.');
    }
  }

  async function loadSyncStatus() {
    try {
      const data = await api<SyncStatusData>('/robots/sync/status');
      setSyncStatus(data);
    } catch { /* endpoint só existe para admins; falha silenciosa */ }
  }

  async function triggerSync() {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await api<{ status: string; output: string }>('/robots/sync', { method: 'POST' });
      setSyncStatus((prev) =>
        prev
          ? { ...prev, lastSyncStatus: result.status, lastSyncAt: new Date().toISOString(), lastSyncOutput: result.output, syncing: false }
          : null,
      );
      notify(result.status === 'success' ? 'Repositório sincronizado.' : `Erro ao sincronizar: ${result.output}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Erro ao sincronizar.');
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleDeleteRobot(robotId: string, robotName: string) {
    try {
      await api(`/robots/${robotId}`, { method: 'DELETE' });
      await refreshHub();
      setConfirmDeleteRobotId(null);
      if (selectedRobotId === robotId) {
        setIsCreatingNew(false);
        setSelectedRobotId(null);
      }
      notify(`Automação "${robotName}" excluída com sucesso.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir a automação.');
      setConfirmDeleteRobotId(null);
    }
  }

  async function handleDeleteSite(siteId: string, siteName: string) {
    try {
      await api(`/sites/${siteId}`, { method: 'DELETE' });
      await loadSites();
      setConfirmDeleteSiteId(null);
      if (selectedSiteId === siteId) {
        setIsCreatingNewSite(false);
        setSelectedSiteId(null);
      }
      notify(`Site "${siteName}" excluído com sucesso.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir o site.');
      setConfirmDeleteSiteId(null);
    }
  }

  if (user?.role !== 'admin') {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Governança do <span className="text-sky-600 dark:text-sky-400">hub</span></>}
        description="Gerencie robôs, departamentos e perfis de acesso da Controller em um único lugar."
        actions={
          activeTab === 'robots' ? (
            <Button
              onClick={() => {
                setIsCreatingNew(true);
                setSelectedRobotId(null);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Nova automação
            </Button>
          ) : activeTab === 'sites' ? (
            <Button
              onClick={() => {
                setIsCreatingNewSite(true);
                setSelectedSiteId(null);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Novo site
            </Button>
          ) : activeTab === 'dashboards' ? (
            <Button
              onClick={() => {
                setIsCreatingNewDashboard(true);
                setSelectedDashboardId(null);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Novo dashboard
            </Button>
          ) : activeTab === 'departments' ? (
            <Button onClick={() => setSelectedDeptId('new')}>
              <Plus className="mr-2 h-4 w-4" />
              Novo departamento
            </Button>
          ) : activeTab === 'docs' ? (
            <Button onClick={() => { setIsCreatingNewDoc(true); setSelectedDocId(null); }}>
              <Plus className="mr-2 h-4 w-4" />
              Nova feature
            </Button>
          ) : undefined
        }
      />

      <div className="flex gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1 dark:border-[#27272a] dark:bg-[#111113]">
        {(
          [
            { key: 'robots', label: 'Automações', count: robots.length },
            { key: 'sites', label: 'Sites', count: sites.length },
            { key: 'dashboards', label: 'Painéis', count: dashboards.length },
            { key: 'users', label: 'Contas', count: users.length },
            { key: 'departments', label: 'Departamentos', count: departments.length },
            { key: 'sistema', label: 'Sistema', count: null },
            { key: 'docs', label: 'Dev Docs', count: docs.length },
          ] as const
        ).map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={[
              'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
              activeTab === key
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
                : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
            ].join(' ')}
          >
            {label}
            {count !== null && (
              <span
                className={[
                  'rounded-full px-1.5 py-0.5 text-xs',
                  activeTab === key
                    ? 'bg-slate-100 text-slate-600 dark:bg-[#27272a] dark:text-zinc-300'
                    : 'bg-transparent text-slate-400 dark:text-zinc-500',
                ].join(' ')}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {hubError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-950/20 dark:text-rose-400">
          <span>Não foi possível carregar as automações do hub.</span>
          <Button variant="outline" onClick={() => void refreshHub()}>
            Tentar novamente
          </Button>
        </div>
      ) : null}

      {activeTab === 'robots' ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr] xl:items-start">
          <Card className="h-fit rounded-3xl">
            <CardHeader>
              <CardTitle>Workspace das automações</CardTitle>
              <CardDescription>Selecione um robô para editar ou crie um novo cadastro.</CardDescription>
              {syncStatus?.configured ? (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
                  <span className="text-xs text-slate-500 dark:text-zinc-400">
                    {isSyncing
                      ? 'Sincronizando...'
                      : syncStatus.lastSyncAt
                        ? `${syncStatus.lastSyncStatus === 'error' ? '⚠ Erro' : '✓'} Sync · ${timeAgo(syncStatus.lastSyncAt)}`
                        : 'Aguardando primeiro sync...'}
                  </span>
                  <button
                    type="button"
                    title="Puxar atualizações do repositório agora"
                    disabled={isSyncing}
                    onClick={() => void triggerSync()}
                    className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-300"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              ) : null}
              <div className="relative pt-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input className="h-9 pl-9 text-sm" placeholder="Buscar automação..." value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </CardHeader>
            <CardContent className="max-h-[62vh] overflow-y-auto px-2 pb-2">
              {filteredRobots.length === 0 ? (
                <p className="px-2 py-1 text-sm text-slate-500 dark:text-zinc-400">
                  Nenhuma automação encontrada para a busca atual.
                </p>
              ) : null}
              {filteredRobots.map((robot) => {
                const isSelected = robot.id === selectedRobot?.id;
                const isConfirmingDelete = confirmDeleteRobotId === robot.id;

                return (
                  <div
                    key={robot.id}
                    className={[
                      'group flex items-start gap-2 rounded-xl px-2 py-2 transition',
                      isSelected
                        ? 'bg-slate-100 dark:bg-[#1b1b20]'
                        : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                    ].join(' ')}
                  >
                    {/* name + category */}
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => { setIsCreatingNew(false); setSelectedRobotId(robot.id); }}
                    >
                      <span className={`block text-sm font-medium leading-snug ${robot.isActive ? 'text-slate-900 dark:text-zinc-100' : 'text-slate-400 dark:text-zinc-500'}`}>
                        {robot.name}
                      </span>
                      <span className="block text-xs text-slate-400 dark:text-zinc-500">
                        {robot.isActive ? (robot.category || 'Sem categoria') : 'Inativa'}
                      </span>
                    </button>

                    {/* actions */}
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteRobotId(null)}
                            className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                          >
                            Não
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteRobot(robot.id, robot.name)}
                            className="text-xs font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
                          >
                            Excluir
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label={`Editar "${robot.name}"`}
                            onClick={() => { setIsCreatingNew(false); setSelectedRobotId(robot.id); }}
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-600 dark:hover:bg-white/5 dark:hover:text-zinc-300"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Excluir automação "${robot.name}"`}
                            onClick={() => setConfirmDeleteRobotId(robot.id)}
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="xl:sticky xl:top-[77px] xl:max-h-[calc(100vh-93px)] xl:overflow-y-auto xl:rounded-3xl xl:pb-2">
          {!selectedRobot && !isCreatingNew ? (
            <Card className="rounded-3xl">
              <CardContent className="grid grid-cols-1 justify-items-center gap-3 py-16 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-[#18181b] dark:text-zinc-500">
                  <Bot className="h-6 w-6" />
                </div>
                <div className="grid gap-1">
                  <p className="font-medium text-slate-900 dark:text-white">Nenhuma automação selecionada</p>
                  <p className="text-sm text-slate-500 dark:text-zinc-400">Escolha uma automação à esquerda para editar, ou crie uma nova.</p>
                </div>
                <Button className="mt-2" onClick={() => { setIsCreatingNew(true); setSelectedRobotId(null); }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Nova automação
                </Button>
              </CardContent>
            </Card>
          ) : renderRobotsTab({
            draft,
            selectedRobot,
            setDraft,
            refreshHub,
            notify,
            setSelectedRobotId,
            departments,
            exampleFile,
            setExampleFile,
            exampleInputName,
            setExampleInputName,
            exampleTitle,
            setExampleTitle,
            exampleDescription,
            setExampleDescription,
            scriptFile,
            setScriptFile,
            scriptEntryScript,
            setScriptEntryScript,
            pipStatus,
            setPipStatus,
            pipPollRef,
            isSavingRobot,
            setIsSavingRobot,
            isManagingApiKey,
            setIsManagingApiKey,
            generatedApiKey,
            setGeneratedApiKey,
          })}
          </div>
        </div>
      ) : activeTab === 'sites' ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr] xl:items-start">
          <Card className="h-fit rounded-3xl">
            <CardHeader>
              <CardTitle>Workspace dos sites</CardTitle>
              <CardDescription>Selecione um site para editar ou cadastre um novo.</CardDescription>
              <div className="relative pt-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input className="h-9 pl-9 text-sm" placeholder="Buscar site..." value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </CardHeader>
            <CardContent className="max-h-[62vh] overflow-y-auto px-2 pb-2">
              {filteredSites.length === 0 ? (
                <p className="px-2 py-1 text-sm text-slate-500 dark:text-zinc-400">
                  Nenhum site encontrado para a busca atual.
                </p>
              ) : null}
              {filteredSites.map((site) => {
                const isSelected = site.id === selectedSiteId;
                const isConfirmingDelete = confirmDeleteSiteId === site.id;

                return (
                  <div
                    key={site.id}
                    className={[
                      'group flex items-start gap-2 rounded-xl px-2 py-2 transition',
                      isSelected
                        ? 'bg-slate-100 dark:bg-[#1b1b20]'
                        : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                    ].join(' ')}
                  >
                    {/* status dot */}
                    <div className="mt-[5px] flex-shrink-0">
                      <StatusDot status={site.status} />
                    </div>

                    {/* favicon */}
                    <div className="mt-0.5 flex-shrink-0">
                      <SiteFavicon siteId={site.id} />
                    </div>

                    {/* name + category */}
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => { setIsCreatingNewSite(false); setSelectedSiteId(site.id); }}
                    >
                      <span className="block text-sm font-medium leading-snug text-slate-900 dark:text-zinc-100">
                        {site.name}
                      </span>
                      <span className="block text-xs text-slate-400 dark:text-zinc-500">
                        {siteCategoryLabel(site.category)}
                      </span>
                    </button>

                    {/* actions */}
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteSiteId(null)}
                            className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                          >
                            Não
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteSite(site.id, site.name)}
                            className="text-xs font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
                          >
                            Excluir
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label={`Editar "${site.name}"`}
                            onClick={() => { setIsCreatingNewSite(false); setSelectedSiteId(site.id); }}
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-600 dark:hover:bg-white/5 dark:hover:text-zinc-300"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Excluir site "${site.name}"`}
                            onClick={() => setConfirmDeleteSiteId(site.id)}
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="xl:sticky xl:top-[77px] xl:max-h-[calc(100vh-93px)] xl:overflow-y-auto xl:rounded-3xl xl:pb-2">
          {!selectedSite && !isCreatingNewSite ? (
            <Card className="rounded-3xl">
              <CardContent className="grid grid-cols-1 justify-items-center gap-3 py-16 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-[#18181b] dark:text-zinc-500">
                  <Globe className="h-6 w-6" />
                </div>
                <div className="grid gap-1">
                  <p className="font-medium text-slate-900 dark:text-white">Nenhum site selecionado</p>
                  <p className="text-sm text-slate-500 dark:text-zinc-400">Escolha um site à esquerda para editar, ou cadastre um novo.</p>
                </div>
                <Button className="mt-2" onClick={() => { setIsCreatingNewSite(true); setSelectedSiteId(null); }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Novo site
                </Button>
              </CardContent>
            </Card>
          ) : renderSitesTab({
            draft: siteDraft,
            selectedSite,
            setDraft: setSiteDraft,
            isSavingSite,
            setIsSavingSite,
            isCheckingSite,
            setIsCheckingSite,
            faviconFile,
            setFaviconFile,
            isSavingFavicon,
            setIsSavingFavicon,
            faviconVersion,
            setFaviconVersion,
            loadSites,
            setSelectedSiteId,
            notify,
          })}
          </div>
        </div>
      ) : activeTab === 'dashboards' ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr] xl:items-start">
          <Card className="h-fit rounded-3xl">
            <CardHeader>
              <CardTitle>Painéis</CardTitle>
              <CardDescription>Selecione um painel para editar ou crie um novo.</CardDescription>
            </CardHeader>
            <CardContent className="max-h-[62vh] overflow-y-auto px-2 pb-2">
              {dashboards.length === 0 ? (
                <p className="px-2 py-1 text-sm text-slate-500 dark:text-zinc-400">Nenhum dashboard cadastrado.</p>
              ) : null}
              {dashboards.map((d) => {
                const isSelected = d.id === selectedDashboardId;
                const isConfirmingDelete = confirmDeleteDashboardId === d.id;
                return (
                  <div
                    key={d.id}
                    className={[
                      'group flex items-start gap-2 rounded-xl px-2 py-2 transition',
                      isSelected ? 'bg-slate-100 dark:bg-[#1b1b20]' : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => { setIsCreatingNewDashboard(false); setSelectedDashboardId(d.id); setDashboardLog([]); }}
                    >
                      <span className={`block text-sm font-medium leading-snug ${d.isActive ? 'text-slate-900 dark:text-zinc-100' : 'text-slate-400 dark:text-zinc-500'}`}>
                        {d.name}
                      </span>
                      <span className="block text-xs text-slate-400 dark:text-zinc-500">
                        {d.type === 'html' ? 'HTML' : d.type === 'streamlit' ? 'Streamlit' : 'Servidor Python'}{!d.isActive ? ' · Inativo' : ''}
                      </span>
                    </button>
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setConfirmDeleteDashboardId(null)} className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300">Não</button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await api(`/dashboards/${d.id}`, { method: 'DELETE' });
                                await loadDashboards();
                                setConfirmDeleteDashboardId(null);
                                if (selectedDashboardId === d.id) { setIsCreatingNewDashboard(false); setSelectedDashboardId(null); }
                                notify(`Dashboard "${d.name}" excluído.`);
                              } catch (e) { notify(e instanceof Error ? e.message : 'Erro ao excluir.'); setConfirmDeleteDashboardId(null); }
                            }}
                            className="text-xs font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
                          >
                            Excluir
                          </button>
                        </div>
                      ) : (
                        <>
                          <button type="button" onClick={() => { setIsCreatingNewDashboard(false); setSelectedDashboardId(d.id); }} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-600 dark:hover:bg-white/5 dark:hover:text-zinc-300"><Pencil className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => setConfirmDeleteDashboardId(d.id)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="xl:sticky xl:top-[77px] xl:max-h-[calc(100vh-93px)] xl:overflow-y-auto xl:rounded-3xl xl:pb-2">
            {!selectedDashboardId && !isCreatingNewDashboard ? (
              <Card className="rounded-3xl">
                <CardContent className="grid grid-cols-1 justify-items-center gap-3 py-16 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-[#18181b] dark:text-zinc-500">
                    <LayoutGrid className="h-6 w-6" />
                  </div>
                  <div className="grid gap-1">
                    <p className="font-medium text-slate-900 dark:text-white">Nenhum dashboard selecionado</p>
                    <p className="text-sm text-slate-500 dark:text-zinc-400">Escolha um dashboard à esquerda para editar, ou crie um novo.</p>
                  </div>
                  <Button className="mt-2" onClick={() => { setIsCreatingNewDashboard(true); setSelectedDashboardId(null); }}>
                    <Plus className="mr-2 h-4 w-4" />
                    Novo dashboard
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card className="rounded-3xl">
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
                  <div>
                    <CardTitle>{dashboardDraft.id ? 'Editar dashboard' : 'Novo dashboard'}</CardTitle>
                    <CardDescription>Configure como esse dashboard é servido e quem pode acessá-lo.</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isSavingDashboard}
                    onClick={async () => {
                      setIsSavingDashboard(true);
                      try {
                        const saved = dashboardDraft.id
                          ? await api<Dashboard>(`/dashboards/${dashboardDraft.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                name: dashboardDraft.name,
                                description: dashboardDraft.description,
                                isActive: dashboardDraft.isActive,
                                allowedDepartments: dashboardDraft.allowedDepartments,
                                minRole: dashboardDraft.minRole,
                                allowedUserIds: dashboardDraft.restrictToUsers ? dashboardDraft.allowedUserIds : [],
                                mainFile: dashboardDraft.mainFile,
                                serverCommand: dashboardDraft.serverCommand || null,
                                serverWorkingDirectory: dashboardDraft.serverWorkingDirectory || null,
                                updatePath: dashboardDraft.updatePath || null,
                                warmupPaths: dashboardDraft.warmupPaths.split('\n').map((s) => s.trim()).filter(Boolean),
                                warmupMode: dashboardDraft.warmupMode,
                                updateFrequency: dashboardDraft.updateFrequency || null,
                                updateTimesOfDay: dashboardDraft.updateFrequency ? dashboardDraft.updateTimesOfDay.filter(Boolean) : [],
                                updateDayOfWeek: dashboardDraft.updateFrequency === 'weekly' ? parseInt(dashboardDraft.updateDayOfWeek) : null,
                                updateDayOfMonth: dashboardDraft.updateFrequency === 'monthly' ? parseInt(dashboardDraft.updateDayOfMonth) : null,
                              }),
                            })
                          : await api<Dashboard>('/dashboards', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                slug: dashboardDraft.slug,
                                name: dashboardDraft.name,
                                description: dashboardDraft.description,
                                type: dashboardDraft.type,
                                isActive: dashboardDraft.isActive,
                                allowedDepartments: dashboardDraft.allowedDepartments,
                                minRole: dashboardDraft.minRole,
                                allowedUserIds: dashboardDraft.restrictToUsers ? dashboardDraft.allowedUserIds : [],
                                mainFile: dashboardDraft.mainFile,
                                serverCommand: dashboardDraft.serverCommand || null,
                                serverWorkingDirectory: dashboardDraft.serverWorkingDirectory || null,
                                updatePath: dashboardDraft.updatePath || null,
                                warmupPaths: dashboardDraft.warmupPaths.split('\n').map((s) => s.trim()).filter(Boolean),
                                warmupMode: dashboardDraft.warmupMode,
                                updateFrequency: dashboardDraft.updateFrequency || null,
                                updateTimesOfDay: dashboardDraft.updateFrequency ? dashboardDraft.updateTimesOfDay.filter(Boolean) : [],
                                updateDayOfWeek: dashboardDraft.updateFrequency === 'weekly' ? parseInt(dashboardDraft.updateDayOfWeek) : null,
                                updateDayOfMonth: dashboardDraft.updateFrequency === 'monthly' ? parseInt(dashboardDraft.updateDayOfMonth) : null,
                              }),
                            });
                        if (dashboardFile) {
                          const formData = new FormData();
                          formData.append('file', dashboardFile);
                          await api(`/dashboards/${saved.id}/upload`, { method: 'POST', body: formData });
                          setDashboardFile(null);
                        }
                        await loadDashboards();
                        setSelectedDashboardId(saved.id);
                        setIsCreatingNewDashboard(false);
                        notify('Dashboard salvo.');
                      } catch (e) {
                        notify(e instanceof Error ? e.message : 'Erro ao salvar dashboard.');
                      } finally {
                        setIsSavingDashboard(false);
                      }
                    }}
                  >
                    {isSavingDashboard ? 'Salvando...' : 'Salvar'}
                  </Button>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-6">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Nome">
                      <Input value={dashboardDraft.name} onChange={(e) => setDashboardDraft({ ...dashboardDraft, name: e.target.value })} />
                    </Field>
                    <Field label="Slug" hint="URL será /d/slug — apenas letras, números e hífens.">
                      <Input value={dashboardDraft.slug} onChange={(e) => setDashboardDraft({ ...dashboardDraft, slug: e.target.value })} />
                    </Field>
                    <Field className="md:col-span-2" label="Descrição">
                      <Input value={dashboardDraft.description} onChange={(e) => setDashboardDraft({ ...dashboardDraft, description: e.target.value })} />
                    </Field>
                    <Field label="Tipo">
                      <select
                        className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                        value={dashboardDraft.type}
                        onChange={(e) => setDashboardDraft({ ...dashboardDraft, type: e.target.value as DashboardType })}
                      >
                        <option value="html">HTML estático</option>
                        <option value="streamlit">Streamlit</option>
                        <option value="server">Servidor Python (FastAPI/uvicorn)</option>
                      </select>
                    </Field>
                    <Field label="Status">
                      <select
                        className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                        value={String(dashboardDraft.isActive)}
                        onChange={(e) => setDashboardDraft({ ...dashboardDraft, isActive: e.target.value === 'true' })}
                      >
                        <option value="true">Ativo</option>
                        <option value="false">Inativo</option>
                      </select>
                    </Field>
                    {(dashboardDraft.type === 'streamlit' || dashboardDraft.type === 'html') && (
                      <Field
                        className="md:col-span-2"
                        label="Diretório do projeto no servidor"
                        hint="Opcional. Se preenchido, os arquivos são servidos/executados diretamente desta pasta — sem precisar fazer upload."
                      >
                        <DirBrowser
                          value={dashboardDraft.serverWorkingDirectory}
                          onChange={(p) => setDashboardDraft((prev) => ({ ...prev, serverWorkingDirectory: p }))}
                        />
                      </Field>
                    )}
                    {dashboardDraft.type === 'streamlit' && (
                      <Field className="md:col-span-2" label="Script principal" hint="Ex: app.py — relativo à pasta do projeto.">
                        <Input value={dashboardDraft.mainFile} onChange={(e) => setDashboardDraft({ ...dashboardDraft, mainFile: e.target.value })} placeholder="app.py" />
                      </Field>
                    )}
                    {dashboardDraft.type === 'server' && (
                      <>
                        <Field className="md:col-span-2" label="Diretório de trabalho" hint="Caminho absoluto onde o comando será executado.">
                          <DirBrowser
                            value={dashboardDraft.serverWorkingDirectory}
                            onChange={(p) => setDashboardDraft((prev) => ({ ...prev, serverWorkingDirectory: p }))}
                            placeholder={String.raw`C:\projetos\meu-app\backend`}
                          />
                        </Field>
                        <Field className="md:col-span-2" label="Comando" hint="Use {PORT} onde o hub deve injetar a porta alocada.">
                          <Input
                            value={dashboardDraft.serverCommand}
                            onChange={(e) => setDashboardDraft({ ...dashboardDraft, serverCommand: e.target.value })}
                            placeholder={String.raw`venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port {PORT}`}
                          />
                        </Field>
                      </>
                    )}
                    <div className="md:col-span-2 grid gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={dashboardDraft.restrictToUsers}
                          onChange={(e) =>
                            setDashboardDraft((prev) => ({
                              ...prev,
                              restrictToUsers: e.target.checked,
                              allowedUserIds: e.target.checked ? prev.allowedUserIds : [],
                            }))
                          }
                        />
                        Restringir a usuários específicos (ignora hierarquia e departamentos abaixo)
                      </label>

                      {dashboardDraft.restrictToUsers ? (
                        <Field
                          label="Usuários com acesso"
                          hint={dashboardDraft.allowedUserIds.length === 0 ? 'Nenhum usuário selecionado — ninguém vai conseguir ver este painel.' : 'Somente essas pessoas verão este painel.'}
                        >
                          <UserPicker
                            users={users}
                            selected={dashboardDraft.allowedUserIds}
                            onToggle={(userId) =>
                              setDashboardDraft((prev) => ({
                                ...prev,
                                allowedUserIds: prev.allowedUserIds.includes(userId)
                                  ? prev.allowedUserIds.filter((id) => id !== userId)
                                  : [...prev.allowedUserIds, userId],
                              }))
                            }
                          />
                        </Field>
                      ) : (
                        <>
                          <Field label="Departamentos com acesso" hint="Vazio = todos podem acessar.">
                            <DepartmentPicker
                              selected={dashboardDraft.allowedDepartments}
                              onToggle={(dept) =>
                                setDashboardDraft((prev) => ({
                                  ...prev,
                                  allowedDepartments: prev.allowedDepartments.includes(dept)
                                    ? prev.allowedDepartments.filter((d) => d !== dept)
                                    : [...prev.allowedDepartments, dept],
                                }))
                              }
                            />
                          </Field>
                          <div className="flex gap-2">
                            {(['employee', 'manager'] as const).map((role) => (
                              <button
                                key={role}
                                type="button"
                                onClick={() => setDashboardDraft((prev) => ({ ...prev, minRole: role }))}
                                className={[
                                  'rounded-xl border px-4 py-2 text-sm font-medium transition',
                                  dashboardDraft.minRole === role
                                    ? 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-300'
                                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b]',
                                ].join(' ')}
                              >
                                {role === 'employee' ? 'Funcionários e gestores' : 'Somente gestores'}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {dashboardDraft.type !== 'server' && !dashboardDraft.serverWorkingDirectory && (
                    <>
                      <Separator />
                      <div className="grid grid-cols-1 gap-3">
                        <div>
                          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
                            {dashboardDraft.type === 'html' ? 'Upload do dashboard HTML' : 'Upload dos arquivos Streamlit'}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                            {dashboardDraft.type === 'html'
                              ? 'Envie um arquivo .html (único) ou .zip (multi-arquivo). O arquivo index.html será a entrada.'
                              : 'Envie um .zip com todos os arquivos Python. O script principal é configurado acima.'}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Input
                            type="file"
                            accept={dashboardDraft.type === 'html' ? '.html,.zip' : '.zip'}
                            className="max-w-xs"
                            onChange={(e) => setDashboardFile(e.target.files?.[0] ?? null)}
                          />
                          {dashboardDraft.id && dashboardFile && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                if (!dashboardDraft.id || !dashboardFile) return;
                                try {
                                  const formData = new FormData();
                                  formData.append('file', dashboardFile);
                                  await api(`/dashboards/${dashboardDraft.id}/upload`, { method: 'POST', body: formData });
                                  setDashboardFile(null);
                                  await loadDashboards();
                                  notify('Arquivo enviado.');
                                } catch (e) { notify(e instanceof Error ? e.message : 'Erro ao enviar arquivo.'); }
                              }}
                            >
                              Enviar arquivo
                            </Button>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {(dashboardDraft.type === 'streamlit' || dashboardDraft.type === 'server') && dashboardDraft.id && (() => {
                    const current = dashboards.find((d) => d.id === dashboardDraft.id);
                    const running = current?.streamlitRunning;
                    const hasError = current?.streamlitStatus === 'error';
                    const label = dashboardDraft.type === 'server' ? 'Servidor' : 'Streamlit';
                    return (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 dark:border-[#27272a]">
                          <div className="flex items-center gap-3">
                            <div className={`h-2 w-2 rounded-full ${running ? 'bg-emerald-500' : hasError ? 'bg-red-500' : 'bg-slate-400 dark:bg-zinc-600'}`} />
                            <span className="text-sm text-slate-700 dark:text-zinc-300">
                              {running ? `Rodando na porta ${current?.streamlitPort}` : hasError ? 'Processo encerrou com erro' : 'Processo parado'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {(hasError || running) && dashboardDraft.id && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { if (dashboardDraft.id) void fetchDashboardLog(dashboardDraft.id); }}
                              >
                                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Logs
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={dashboardAction !== null}
                              onClick={async () => {
                                if (!dashboardDraft.id) return;
                                const action = running ? 'stop' : 'start';
                                setDashboardAction(action);
                                try {
                                  await api(`/dashboards/${dashboardDraft.id}/${action}`, { method: 'POST' });
                                  await loadDashboards();
                                  if (dashboardDraft.id) void fetchDashboardLog(dashboardDraft.id);
                                  notify(action === 'start' ? `${label} iniciado.` : `${label} parado.`);
                                } catch (e) { notify(e instanceof Error ? e.message : 'Erro.'); }
                                finally { setDashboardAction(null); }
                              }}
                            >
                              {running ? <><Square className="mr-1.5 h-3.5 w-3.5" />Parar</> : <><Play className="mr-1.5 h-3.5 w-3.5" />Iniciar</>}
                            </Button>
                          </div>
                        </div>
                        {dashboardLog.length > 0 && (
                          <div className="rounded-lg bg-slate-950 p-3 dark:bg-zinc-900">
                            <pre className="max-h-48 overflow-y-auto text-xs leading-relaxed text-slate-300 dark:text-zinc-400 whitespace-pre-wrap break-all">
                              {dashboardLog.join('\n')}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {(dashboardDraft.type === 'streamlit' || dashboardDraft.type === 'server') && (
                    <>
                      <Separator />
                      <div className="flex flex-col gap-4">
                        <div>
                          <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">Atualização automática</p>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                            Endpoint chamado pelo hub para forçar o recarregamento dos dados do painel.
                          </p>
                        </div>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          <Field className="md:col-span-2" label="Endpoint de atualização" hint="Caminho POST que o hub chamará. Ex: /api/atualizar">
                            <Input
                              value={dashboardDraft.updatePath}
                              onChange={(e) => setDashboardDraft({ ...dashboardDraft, updatePath: e.target.value })}
                              placeholder="/api/atualizar"
                            />
                          </Field>
                          <Field className="md:col-span-2" label="Aquecimento após atualizar">
                            <div className="flex flex-wrap gap-2">
                              {([
                                { value: 'disabled', label: 'Desabilitado' },
                                { value: 'manual', label: 'Rotas manuais' },
                                { value: 'auto', label: 'Automático (via OpenAPI)' },
                              ] as const).map((option) => (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => setDashboardDraft({ ...dashboardDraft, warmupMode: option.value })}
                                  className={[
                                    'rounded-xl border px-4 py-2 text-sm font-medium transition',
                                    dashboardDraft.warmupMode === option.value
                                      ? 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-300'
                                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b]',
                                  ].join(' ')}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </Field>
                          {dashboardDraft.warmupMode === 'manual' && (
                            <Field className="md:col-span-2" label="Rotas manuais" hint="Um caminho por linha. O hub fará GET em cada rota após atualizar (best-effort).">
                              <textarea
                                rows={3}
                                value={dashboardDraft.warmupPaths}
                                onChange={(e) => setDashboardDraft({ ...dashboardDraft, warmupPaths: e.target.value })}
                                placeholder={'/api/clientes\n/api/resumo'}
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/20 dark:border-[#3b3b42] dark:bg-[#18181b] dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:ring-zinc-700"
                              />
                            </Field>
                          )}
                          {dashboardDraft.warmupMode === 'auto' && (
                            <p className="md:col-span-2 text-xs text-slate-500 dark:text-zinc-400">
                              O hub busca <code>/openapi.json</code> no app e aquece sozinho toda rota GET sem parâmetro na URL — não precisa listar nada manualmente. Se o app não expuser esse arquivo, cai de volta pra lista manual configurada (se houver).
                            </p>
                          )}
                          <Field label="Frequência">
                            <select
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 dark:border-[#3b3b42] dark:bg-[#18181b] dark:text-zinc-100 dark:focus:ring-zinc-700"
                              value={dashboardDraft.updateFrequency}
                              onChange={(e) => setDashboardDraft({ ...dashboardDraft, updateFrequency: e.target.value })}
                            >
                              <option value="">Desativado</option>
                              <option value="daily">Diário</option>
                              <option value="weekly">Semanal</option>
                              <option value="monthly">Mensal</option>
                            </select>
                          </Field>
                          {dashboardDraft.updateFrequency && (
                            <Field className="md:col-span-2" label="Horários">
                              <div className="flex flex-col gap-1.5">
                                {dashboardDraft.updateTimesOfDay.map((t, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <Input
                                      type="time"
                                      value={t}
                                      onChange={(e) => setDashboardDraft((d) => ({
                                        ...d,
                                        updateTimesOfDay: d.updateTimesOfDay.map((x, j) => j === i ? e.target.value : x),
                                      }))}
                                      className="w-32"
                                    />
                                    {dashboardDraft.updateTimesOfDay.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => setDashboardDraft((d) => ({
                                          ...d,
                                          updateTimesOfDay: d.updateTimesOfDay.filter((_, j) => j !== i),
                                        }))}
                                        className="rounded-lg p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => setDashboardDraft((d) => ({ ...d, updateTimesOfDay: [...d.updateTimesOfDay, '08:00'] }))}
                                  className="flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                >
                                  <Plus className="h-3 w-3" />
                                  Adicionar horário
                                </button>
                              </div>
                            </Field>
                          )}
                          {dashboardDraft.updateFrequency === 'weekly' && (
                            <Field label="Dia da semana">
                              <select
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/20 dark:border-[#3b3b42] dark:bg-[#18181b] dark:text-zinc-100 dark:focus:ring-zinc-700"
                                value={dashboardDraft.updateDayOfWeek}
                                onChange={(e) => setDashboardDraft({ ...dashboardDraft, updateDayOfWeek: e.target.value })}
                              >
                                <option value="0">Domingo</option>
                                <option value="1">Segunda-feira</option>
                                <option value="2">Terça-feira</option>
                                <option value="3">Quarta-feira</option>
                                <option value="4">Quinta-feira</option>
                                <option value="5">Sexta-feira</option>
                                <option value="6">Sábado</option>
                              </select>
                            </Field>
                          )}
                          {dashboardDraft.updateFrequency === 'monthly' && (
                            <Field label="Dia do mês" hint="1–28">
                              <Input
                                type="number"
                                min={1}
                                max={28}
                                value={dashboardDraft.updateDayOfMonth}
                                onChange={(e) => setDashboardDraft({ ...dashboardDraft, updateDayOfMonth: e.target.value })}
                              />
                            </Field>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      ) : activeTab === 'sistema' ? (
        <div className="grid grid-cols-1 gap-5 sm:max-w-lg">
          <Card>
            <CardHeader>
              <CardTitle>Runner de execuções</CardTitle>
              <CardDescription>
                Controla quantos robôs rodam ao mesmo tempo e o limite de RAM.
                Mudanças entram em vigor imediatamente.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <StepperRow
                label="Execuções simultâneas"
                description="Máximo de robôs rodando ao mesmo tempo (1–10). Chrome/BotCity usa ~300–500 MB cada."
                value={systemSettings?.runnerMaxConcurrency ?? null}
                format={(v) => String(v)}
                onDecrement={() => systemSettings && void saveSystemSettings({ runnerMaxConcurrency: systemSettings.runnerMaxConcurrency - 1 })}
                onIncrement={() => systemSettings && void saveSystemSettings({ runnerMaxConcurrency: systemSettings.runnerMaxConcurrency + 1 })}
                canDecrement={(systemSettings?.runnerMaxConcurrency ?? 1) > 1}
                canIncrement={(systemSettings?.runnerMaxConcurrency ?? 10) < 10}
                disabled={isSavingSystem}
              />
              <Separator />
              <StepperRow
                label="Limite de memória"
                description="Se a RAM passar deste percentual, novas execuções ficam na fila (50–99%)."
                value={systemSettings?.runnerMemoryThreshold ?? null}
                format={(v) => `${v}%`}
                onDecrement={() => systemSettings && void saveSystemSettings({ runnerMemoryThreshold: systemSettings.runnerMemoryThreshold - 5 })}
                onIncrement={() => systemSettings && void saveSystemSettings({ runnerMemoryThreshold: systemSettings.runnerMemoryThreshold + 5 })}
                canDecrement={(systemSettings?.runnerMemoryThreshold ?? 50) > 50}
                canIncrement={(systemSettings?.runnerMemoryThreshold ?? 99) < 99}
                disabled={isSavingSystem}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Armazenamento de execuções</CardTitle>
              <CardDescription>
                Arquivos e logs são apagados automaticamente conforme o prazo configurado abaixo. Use 0 para nunca limpar.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {storageMb !== null && (
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-[#27272a] dark:bg-[#111113]">
                  <span className="text-sm text-slate-600 dark:text-zinc-400">Tamanho atual da pasta de execuções</span>
                  <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-zinc-100">
                    {storageMb >= 1024 ? `${(storageMb / 1024).toFixed(1)} GB` : `${storageMb} MB`}
                  </span>
                </div>
              )}
              <StepperRow
                label="Retenção sem retorno (dias)"
                description="Execuções que não geraram arquivo de saída — logs e inputs removidos após este prazo. 0 = nunca limpar."
                value={systemSettings?.executionRetentionDays ?? null}
                format={(v) => v === 0 ? 'Nunca' : `${v}d`}
                onDecrement={() => systemSettings && void saveSystemSettings({ executionRetentionDays: Math.max(0, systemSettings.executionRetentionDays - 1) })}
                onIncrement={() => systemSettings && void saveSystemSettings({ executionRetentionDays: systemSettings.executionRetentionDays + 1 })}
                canDecrement={(systemSettings?.executionRetentionDays ?? 0) > 0}
                canIncrement={true}
                disabled={isSavingSystem}
              />
              <Separator />
              <StepperRow
                label="Retenção com retorno (dias)"
                description="Execuções que geraram arquivos de saída para download — removidos após este prazo. 0 = nunca limpar."
                value={systemSettings?.executionRetentionDaysWithOutput ?? null}
                format={(v) => v === 0 ? 'Nunca' : `${v}d`}
                onDecrement={() => systemSettings && void saveSystemSettings({ executionRetentionDaysWithOutput: Math.max(0, systemSettings.executionRetentionDaysWithOutput - 1) })}
                onIncrement={() => systemSettings && void saveSystemSettings({ executionRetentionDaysWithOutput: systemSettings.executionRetentionDaysWithOutput + 1 })}
                canDecrement={(systemSettings?.executionRetentionDaysWithOutput ?? 0) > 0}
                canIncrement={true}
                disabled={isSavingSystem}
              />
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-zinc-100">Limpar agora</div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                    Roda a limpeza imediatamente sem esperar o ciclo automático de 6h.
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={isSweeping} onClick={() => void triggerSweep()}>
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isSweeping ? 'animate-spin' : ''}`} />
                  {isSweeping ? 'Limpando…' : 'Limpar'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : activeTab === 'docs' ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr] xl:items-start">
          {/* Lista de docs */}
          <Card className="h-fit rounded-3xl">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Code2 className="h-4 w-4" />
                Features documentadas
              </CardTitle>
              <CardDescription>Banco de contexto para integrações e IAs</CardDescription>
              <div className="relative mt-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input className="h-9 pl-9" placeholder="Buscar..." value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {docs.filter((d) => !query || d.title.toLowerCase().includes(query.toLowerCase()) || d.category.toLowerCase().includes(query.toLowerCase()) || d.tags.some((t) => t.toLowerCase().includes(query.toLowerCase()))).length === 0 ? (
                <p className="px-6 pb-6 text-sm text-slate-400">Nenhuma feature cadastrada.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-[#27272a]">
                  {docs
                    .filter((d) => !query || d.title.toLowerCase().includes(query.toLowerCase()) || d.category.toLowerCase().includes(query.toLowerCase()) || d.tags.some((t) => t.toLowerCase().includes(query.toLowerCase())))
                    .map((doc) => (
                      <li key={doc.id}>
                        <button
                          type="button"
                          onClick={() => { setSelectedDocId(doc.id); setIsCreatingNewDoc(false); }}
                          className={['w-full px-5 py-3.5 text-left transition hover:bg-slate-50 dark:hover:bg-[#1b1b20]', selectedDocId === doc.id ? 'bg-slate-100 dark:bg-[#1b1b20]' : ''].join(' ')}
                        >
                          <p className="truncate text-sm font-medium">{doc.title}</p>
                          <p className="mt-0.5 truncate text-xs text-slate-500">{doc.category}{doc.language ? ` · ${doc.language}` : ''}</p>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Painel de detalhe / formulário */}
          {(selectedDocId || isCreatingNewDoc) ? (() => {
            const isNew = isCreatingNewDoc;

            function copyDocAsPrompt(d: typeof docDraft, id?: string) {
              const originalDoc = id ? docs.find((x) => x.id === id) : null;
              const lines: string[] = [
                `## ${d.title || '(sem título)'}`,
                `**Categoria:** ${d.category || '—'}`,
                `**Resumo:** ${d.summary || '—'}`,
                '',
                `**Como usar:**`,
                d.howToUse || '—',
              ];
              if (d.codeExample) {
                lines.push('', `**Exemplo de código${d.language ? ` (${d.language})` : ''}:**`);
                lines.push('```' + (d.language || ''));
                lines.push(d.codeExample);
                lines.push('```');
              }
              if (d.endpoint) lines.push('', `**Endpoint:** \`${d.endpoint}\``);
              if (d.tags) lines.push('', `**Tags:** ${d.tags}`);
              if (originalDoc) lines.push('', `*Atualizado em: ${new Date(originalDoc.updatedAt).toLocaleDateString('pt-BR')}*`);
              void navigator.clipboard.writeText(lines.join('\n')).then(() => notify('Copiado como prompt!'));
            }

            async function saveDoc() {
              setIsSavingDoc(true);
              try {
                const payload = {
                  title: docDraft.title.trim(),
                  category: docDraft.category.trim(),
                  summary: docDraft.summary.trim(),
                  howToUse: docDraft.howToUse.trim(),
                  codeExample: docDraft.codeExample.trim() || null,
                  language: docDraft.language.trim() || null,
                  endpoint: docDraft.endpoint.trim() || null,
                  tags: docDraft.tags.split(',').map((t) => t.trim()).filter(Boolean),
                  order: docDraft.order ? Number(docDraft.order) : undefined,
                };
                if (isNew) {
                  const created = await api<DevDoc>('/dev-docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                  await loadDocs();
                  setIsCreatingNewDoc(false);
                  setSelectedDocId(created.id);
                  notify('Feature salva.');
                } else {
                  await api(`/dev-docs/${selectedDocId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                  await loadDocs();
                  notify('Feature atualizada.');
                }
              } catch (e) {
                notify(e instanceof Error ? e.message : 'Erro ao salvar.');
              } finally {
                setIsSavingDoc(false);
              }
            }

            async function deleteDoc() {
              if (!selectedDocId) return;
              try {
                await api(`/dev-docs/${selectedDocId}`, { method: 'DELETE' });
                await loadDocs();
                setSelectedDocId(null);
                setConfirmDeleteDocId(null);
                notify('Feature removida.');
              } catch (e) {
                notify(e instanceof Error ? e.message : 'Erro ao remover.');
              }
            }

            const CATEGORIES = ['Protocolo do Robô', 'APIs', 'Integrações', 'Frontend', 'Banco de Dados', 'Deploy', 'Autenticação'];

            return (
              <Card className="rounded-3xl">
                <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
                  <div>
                    <CardTitle className="text-base">{isNew ? 'Nova feature' : 'Editar feature'}</CardTitle>
                    <CardDescription className="mt-1">Preencha os campos para documentar esta funcionalidade</CardDescription>
                  </div>
                  {!isNew && (
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" size="sm" onClick={() => copyDocAsPrompt(docDraft, selectedDocId ?? undefined)}>
                        <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
                        Copiar como prompt
                      </Button>
                      {confirmDeleteDocId === selectedDocId ? (
                        <div className="flex gap-1">
                          <Button variant="danger" size="sm" onClick={() => void deleteDoc()}>Confirmar exclusão</Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteDocId(null)}>Cancelar</Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteDocId(selectedDocId)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label="Título da feature *">
                      <Input placeholder="ex.: AH_METRIC — Métricas de Tempo Economizado" value={docDraft.title} onChange={(e) => setDocDraft((p) => ({ ...p, title: e.target.value }))} />
                    </Field>
                  </div>
                  <Field label="Categoria">
                    <Input list="doc-categories" placeholder="ex.: Protocolo do Robô" value={docDraft.category} onChange={(e) => setDocDraft((p) => ({ ...p, category: e.target.value }))} />
                    <datalist id="doc-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
                  </Field>
                  <Field label="Endpoint / Comando (opcional)">
                    <Input placeholder="ex.: GET /api/time-savings" value={docDraft.endpoint} onChange={(e) => setDocDraft((p) => ({ ...p, endpoint: e.target.value }))} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Resumo — o que faz? *">
                      <Textarea rows={2} placeholder="Em 1-2 frases, explique o que esta funcionalidade faz." value={docDraft.summary} onChange={(e) => setDocDraft((p) => ({ ...p, summary: e.target.value }))} />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Field label="Como usar *">
                      <Textarea rows={5} placeholder="Passo a passo ou descrição de como integrar / usar esta funcionalidade." value={docDraft.howToUse} onChange={(e) => setDocDraft((p) => ({ ...p, howToUse: e.target.value }))} />
                    </Field>
                  </div>
                  <Field label="Linguagem do exemplo (opcional)">
                    <Input list="doc-languages" placeholder="ex.: python, json, http, bash" value={docDraft.language} onChange={(e) => setDocDraft((p) => ({ ...p, language: e.target.value }))} />
                    <datalist id="doc-languages">{['python', 'typescript', 'json', 'http', 'bash', 'sql'].map((l) => <option key={l} value={l} />)}</datalist>
                  </Field>
                  <Field label="Tags (separadas por vírgula)">
                    <Input placeholder="ex.: rpa, protocolo, métricas" value={docDraft.tags} onChange={(e) => setDocDraft((p) => ({ ...p, tags: e.target.value }))} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Exemplo de código (opcional)">
                      <Textarea rows={6} className="font-mono text-sm" placeholder={`Cole aqui o trecho de código de exemplo...`} value={docDraft.codeExample} onChange={(e) => setDocDraft((p) => ({ ...p, codeExample: e.target.value }))} />
                    </Field>
                  </div>
                  <div className="sm:col-span-2 flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-[#27272a]">
                    <Button variant="ghost" onClick={() => { setSelectedDocId(null); setIsCreatingNewDoc(false); }}>Cancelar</Button>
                    <Button onClick={() => void saveDoc()} disabled={isSavingDoc || !docDraft.title.trim() || !docDraft.summary.trim() || !docDraft.howToUse.trim()}>
                      {isSavingDoc ? 'Salvando...' : isNew ? 'Criar feature' : 'Salvar alterações'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })() : (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-200 py-16 text-center dark:border-[#27272a]">
              <Code2 className="mb-3 h-8 w-8 text-slate-300" />
              <p className="text-sm font-medium text-slate-500">Selecione uma feature ou crie uma nova</p>
              <p className="mt-1 text-xs text-slate-400">O contexto salvo aqui pode ser colado em conversas com IAs</p>
            </div>
          )}
        </div>
      ) : activeTab === 'departments' ? (
        renderDepartmentsTab({
          departments,
          selectedDeptId,
          setSelectedDeptId,
          deptDraft,
          setDeptDraft,
          isSavingDept,
          setIsSavingDept,
          confirmDeleteDeptId,
          setConfirmDeleteDeptId,
          notify,
          refreshDepartments,
          query,
          setQuery,
        })
      ) : (
        <div className="grid grid-cols-1 gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="h-10 pl-9" placeholder="Buscar usuário..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Button onClick={() => setIsCreatingNewUser((prev) => !prev)}>
              <Plus className="mr-2 h-4 w-4" />
              {isCreatingNewUser ? 'Cancelar' : 'Criar usuário'}
            </Button>
          </div>
          <NewUserCard
            isOpen={isCreatingNewUser}
            onOpenChange={setIsCreatingNewUser}
            notify={notify}
            loadUsers={loadUsers}
          />
          {renderUsersTab({
            users: filteredUsers,
            linkableUsers: users,
            notify,
            loadUsers,
            editingUserId,
            setEditingUserId,
            closingUserId,
            setClosingUserId,
            userDraft,
            setUserDraft,
            isSavingUser,
            setIsSavingUser,
          })}
        </div>
      )}
    </div>
  );
}

type DirBrowseResult = { current: string | null; parent: string | null; dirs: string[]; roots: string[] };

function DirBrowser({ value, onChange, placeholder }: { value: string; onChange: (p: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [result, setResult] = useState<DirBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchDir(path?: string) {
    setLoading(true);
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      const data = await api<DirBrowseResult>(`/system/browse-dir${qs}`);
      setResult(data);
      setBrowsePath(data.current);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  function handleToggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    void fetchDir(value || undefined);
  }

  const dirName = (fullPath: string) => fullPath.split(/[/\\]/).filter(Boolean).at(-1) ?? fullPath;

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input
          className="flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={handleToggle}
          title="Navegar pelo servidor"
          className={[
            'flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border transition',
            open
              ? 'border-sky-400 bg-sky-50 text-sky-600 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-400'
              : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-400 dark:hover:text-zinc-200',
          ].join(' ')}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-[#27272a] dark:bg-[#111113]">
          {result && result.roots.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {result.roots.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={loading}
                  onClick={() => void fetchDir(r)}
                  className={[
                    'rounded-lg border px-2 py-0.5 font-mono text-xs transition',
                    result.current?.toUpperCase().startsWith(r.slice(0, 2).toUpperCase())
                      ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-500 dark:bg-sky-900/20 dark:text-sky-300'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100 dark:border-[#2b2b31] dark:bg-[#1b1b20] dark:text-zinc-400 dark:hover:bg-[#27272a]',
                  ].join(' ')}
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          {result?.current ? (
            <>
              <div className="mb-2 truncate rounded-lg bg-white px-2 py-1 font-mono text-xs text-slate-600 dark:bg-[#0f0f10] dark:text-zinc-400">
                {result.current}
              </div>
              <div className="max-h-52 overflow-y-auto rounded-lg">
                {result.parent && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void fetchDir(result.parent!)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-200 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-[#1b1b20]"
                  >
                    <span>↑</span>
                    <span>Subir</span>
                  </button>
                )}
                {loading ? (
                  <div className="px-2 py-2 text-xs text-slate-400 dark:text-zinc-500">Carregando...</div>
                ) : result.dirs.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-slate-400 dark:text-zinc-500">Nenhuma subpasta</div>
                ) : (
                  result.dirs.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => void fetchDir(d)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-200 dark:hover:bg-[#1b1b20]"
                    >
                      <span className="text-amber-500 dark:text-amber-400">📁</span>
                      <span className="truncate text-slate-800 dark:text-zinc-200">{dirName(d)}</span>
                    </button>
                  ))
                )}
              </div>
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  disabled={!browsePath}
                  onClick={() => { if (browsePath) { onChange(browsePath); setOpen(false); } }}
                >
                  Usar esta pasta
                </Button>
              </div>
            </>
          ) : (
            !loading && result && (
              <p className="text-xs text-slate-400 dark:text-zinc-500">Selecione um drive acima para começar.</p>
            )
          )}

          {loading && !result?.current && (
            <div className="text-xs text-slate-400 dark:text-zinc-500">Carregando...</div>
          )}
        </div>
      )}
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((prev) => !prev)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function UserPicker({
  users,
  selected,
  onToggle,
}: {
  users: ManagedUser[];
  selected: string[];
  onToggle: (userId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {users.map((managedUser) => {
        const active = selected.includes(managedUser.id);

        return (
          <button
            key={managedUser.id}
            type="button"
            aria-pressed={active}
            className={[
              'rounded-2xl border px-4 py-3 text-left text-sm transition',
              active
                ? 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-300'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b]',
            ].join(' ')}
            onClick={() => onToggle(managedUser.id)}
          >
            <div className="font-medium">{managedUser.name}</div>
            <div className="text-xs opacity-70">{managedUser.email}</div>
          </button>
        );
      })}
      {users.length === 0 && (
        <p className="col-span-full text-sm text-slate-500 dark:text-zinc-400">Nenhum usuário cadastrado.</p>
      )}
    </div>
  );
}

function DepartmentPicker({
  selected,
  onToggle,
}: {
  selected: Department[];
  onToggle: (department: Department) => void;
}) {
  const { departments } = useHub();
  const options = departments.filter((d) => d.isActive);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {options.map((dept) => {
        const active = selected.includes(dept.slug);

        return (
          <button
            key={dept.slug}
            type="button"
            aria-pressed={active}
            className={[
              'rounded-2xl border px-4 py-3 text-left text-sm transition',
              active
                ? 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-300'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b]',
            ].join(' ')}
            onClick={() => onToggle(dept.slug)}
          >
            {dept.name}
          </button>
        );
      })}
      {options.length === 0 && (
        <p className="col-span-full text-sm text-slate-500 dark:text-zinc-400">Nenhum departamento cadastrado.</p>
      )}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-5">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-slate-500 dark:text-zinc-400">{description}</p>
      </div>
      {children}
      <Separator />
    </div>
  );
}

function BuilderSection({
  title,
  description,
  onAdd,
  children,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-slate-500 dark:text-zinc-400">{description}</p>
        </div>
        <Button variant="outline" onClick={onAdd}>
          Adicionar
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4">{children}</div>
      <Separator />
    </div>
  );
}

function renderRobotsTab({
  draft,
  selectedRobot,
  setDraft,
  refreshHub,
  notify,
  setSelectedRobotId,
  departments,
  exampleFile,
  setExampleFile,
  exampleInputName,
  setExampleInputName,
  exampleTitle,
  setExampleTitle,
  exampleDescription,
  setExampleDescription,
  scriptFile,
  setScriptFile,
  scriptEntryScript,
  setScriptEntryScript,
  pipStatus,
  setPipStatus,
  pipPollRef,
  isSavingRobot,
  setIsSavingRobot,
  isManagingApiKey,
  setIsManagingApiKey,
  generatedApiKey,
  setGeneratedApiKey,
}: {
  draft: Draft;
  selectedRobot: Robot | null;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  refreshHub: () => Promise<void>;
  notify: (message: string) => void;
  setSelectedRobotId: (value: string | null) => void;
  departments: DepartmentConfig[];
  exampleFile: File | null;
  setExampleFile: React.Dispatch<React.SetStateAction<File | null>>;
  exampleInputName: string;
  setExampleInputName: React.Dispatch<React.SetStateAction<string>>;
  exampleTitle: string;
  setExampleTitle: React.Dispatch<React.SetStateAction<string>>;
  exampleDescription: string;
  setExampleDescription: React.Dispatch<React.SetStateAction<string>>;
  scriptFile: File | null;
  setScriptFile: React.Dispatch<React.SetStateAction<File | null>>;
  scriptEntryScript: string;
  setScriptEntryScript: React.Dispatch<React.SetStateAction<string>>;
  pipStatus: 'installing' | 'done' | 'error' | null;
  setPipStatus: React.Dispatch<React.SetStateAction<'installing' | 'done' | 'error' | null>>;
  pipPollRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
  isSavingRobot: boolean;
  setIsSavingRobot: React.Dispatch<React.SetStateAction<boolean>>;
  isManagingApiKey: boolean;
  setIsManagingApiKey: React.Dispatch<React.SetStateAction<boolean>>;
  generatedApiKey: string | null;
  setGeneratedApiKey: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const startPipStatusPolling = (robotId: string) => {
    if (pipPollRef.current) clearInterval(pipPollRef.current);
    setPipStatus('installing');
    let attempts = 0;
    pipPollRef.current = setInterval(async () => {
      attempts += 1;
      // Após restart do servidor o status em memória some; não polla para sempre
      if (attempts > 150) {
        if (pipPollRef.current) clearInterval(pipPollRef.current);
        setPipStatus(null);
        return;
      }
      try {
        const res = await api<{ status: string | null }>(`/robots/${robotId}/pip-status`);
        if (res.status === 'done' || res.status === 'error') {
          setPipStatus(res.status as 'done' | 'error');
          if (pipPollRef.current) clearInterval(pipPollRef.current);
        }
      } catch {
        if (pipPollRef.current) clearInterval(pipPollRef.current);
      }
    }, 2000);
  };

  async function handleGenerateApiKey() {
    if (!draft.id || isManagingApiKey) return;
    setIsManagingApiKey(true);
    try {
      const result = await api<{ apiKey: string }>(`/robots/${draft.id}/api-key`, { method: 'POST' });
      setGeneratedApiKey(result.apiKey);
      await refreshHub();
      notify('Nova chave de API gerada.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível gerar a chave de API.');
    } finally {
      setIsManagingApiKey(false);
    }
  }

  async function handleRevokeApiKey() {
    if (!draft.id || isManagingApiKey) return;
    setIsManagingApiKey(true);
    try {
      await api(`/robots/${draft.id}/api-key`, { method: 'DELETE' });
      setGeneratedApiKey(null);
      await refreshHub();
      notify('Chave de API revogada.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível revogar a chave.');
    } finally {
      setIsManagingApiKey(false);
    }
  }

  async function handleSaveRobot() {
    if (isSavingRobot) return;
    setIsSavingRobot(true);
    try {
      const saved = await api<Robot>('/robots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: draft.id,
          slug: draft.slug,
          name: draft.name,
          summary: draft.summary,
          description: draft.description,
          category: draft.category,
          icon: draft.icon,
          isActive: draft.isActive,
          version: draft.version,
          maxConcurrency: draft.maxConcurrency,
          manualSecondsPerUnit: draft.manualSecondsPerUnit,
          unitLabel: draft.unitLabel,
          unitMetricKey: draft.unitMetricKey,
          conflictKeys: draft.conflictKeys,
          zipOutput: draft.zipOutput,
          isExternal: draft.isExternal,
          command: draft.command,
          workingDirectory: draft.workingDirectory,
          allowedDepartments: draft.allowedDepartments,
          documentationUrl: draft.documentationUrl,
          documentationLabel: draft.documentationLabel,
          supportLabel: draft.supportLabel,
          supportValue: draft.supportValue,
          dataPolicy: draft.dataPolicy,
          schema: { fields: draft.fields, fileInputs: draft.fileInputs },
        }),
      });
      if (scriptFile && scriptEntryScript.trim()) {
        try {
          const formData = new FormData();
          formData.append('file', scriptFile);
          formData.append('entryScript', scriptEntryScript.trim());
          await api(`/robots/${saved.id}/scripts`, { method: 'POST', body: formData });
          setScriptFile(null);
          setScriptEntryScript('');
        } catch {
          notify('Automação salva, mas o upload dos scripts falhou. Tente novamente na seção "Script da automação".');
          await refreshHub();
          setSelectedRobotId(saved.id);
          return;
        }
      }
      await refreshHub();
      setSelectedRobotId(saved.id);
      notify(scriptFile ? 'Automação salva e scripts enviados.' : 'Automação salva com sucesso.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar a automação.');
    } finally {
      setIsSavingRobot(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-zinc-400">
        <Badge className="border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/35 dark:bg-slate-800 dark:text-zinc-200">
          {draft.name || 'Nova automação'}
        </Badge>
        <Badge className="border-indigo-200 bg-indigo-100 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-950 dark:text-indigo-200">
          Concorrência: {draft.maxConcurrency || '1'}
        </Badge>
        <Badge className="border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/40 dark:bg-sky-950 dark:text-sky-200">
          Pasta: {draft.workingDirectory || 'Não definida'}
        </Badge>
        <Badge className="border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/35 dark:bg-slate-800 dark:text-zinc-200">
          Acesso: {draft.allowedDepartments.length > 0 ? `${draft.allowedDepartments.length} dept.` : 'Todos'}
        </Badge>
      </div>

      <Card className="rounded-3xl">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>{draft.id ? 'Editar automação' : 'Nova automação'}</CardTitle>
            <CardDescription>Preencha os dados abaixo para publicar a automação no hub.</CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={isSavingRobot} onClick={handleSaveRobot}>
            {isSavingRobot ? 'Salvando...' : 'Salvar'}
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-8">
          <Section title="Identidade" description="Como essa automação aparece no catálogo.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Nome">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Slug">
                <Input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              </Field>
              <Field label="Categoria">
                <select
                  className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                >
                  <option value="">Sem categoria</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Ícone">
                <select
                  className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                  value={draft.icon}
                  onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                >
                  {['bot', 'bank', 'receipt', 'chart'].map((icon) => (
                    <option key={icon} value={icon}>
                      {icon}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Versão">
                <Input value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
              </Field>
              <Field className="md:col-span-2" label="Resumo">
                <Input value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
              </Field>
              <Field className="md:col-span-2" label="Descrição">
                <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section title="Acesso e orquestração" description="Quem pode ver o robô e como o runner deve tratá-lo.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Concorrência máxima" hint="Quantas execuções desse robô podem rodar ao mesmo tempo.">
                <Input type="number" min="1" value={draft.maxConcurrency} onChange={(e) => setDraft({ ...draft, maxConcurrency: e.target.value })} />
              </Field>
              <Field label="Grupos de conflito" hint="Tags separadas por vírgula para impedir robôs diferentes de rodarem juntos.">
                <Input value={draft.conflictKeys} onChange={(e) => setDraft({ ...draft, conflictKeys: e.target.value })} placeholder="Ex: sefaz, conta-fiscal" />
              </Field>
              <Field className="md:col-span-2" label="Departamentos com acesso" hint="Se nada for marcado, a automação ficará visível para toda a empresa.">
                <DepartmentPicker
                  selected={draft.allowedDepartments}
                  onToggle={(department) =>
                    setDraft((current) => ({
                      ...current,
                      allowedDepartments: current.allowedDepartments.includes(department)
                        ? current.allowedDepartments.filter((item) => item !== department)
                        : [...current.allowedDepartments, department],
                    }))
                  }
                />
              </Field>
              <Field
                className="md:col-span-2"
                label="Tipo de automação"
                hint="Externa = não roda pelo hub; outro sistema executa e reporta o tempo economizado via API."
              >
                <select
                  className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                  value={draft.isExternal ? 'external' : 'internal'}
                  onChange={(e) => setDraft({ ...draft, isExternal: e.target.value === 'external' })}
                >
                  <option value="internal">Executada pelo hub</option>
                  <option value="external">Externa (reportada via API)</option>
                </select>
              </Field>
              {!draft.isExternal && !draft.workingDirectory?.replace(/\\/g, '/').includes('/scripts') ? (
                <>
                  <Field className="md:col-span-2" label="Comando de execução">
                    <Input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
                  </Field>
                  <Field className="md:col-span-2" label="Pasta de execução">
                    <DirBrowser
                      value={draft.workingDirectory}
                      onChange={(p) => setDraft((prev) => ({ ...prev, workingDirectory: p }))}
                    />
                  </Field>
                </>
              ) : null}
              <Field label="Status">
                <select
                  className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                  value={String(draft.isActive)}
                  onChange={(e) => setDraft({ ...draft, isActive: e.target.value === 'true' })}
                >
                  <option value="true">Ativa</option>
                  <option value="false">Inativa</option>
                </select>
              </Field>
            </div>
          </Section>

          {draft.isExternal ? (
            <Section
              title="Integração externa"
              description="Outro sistema chama este endpoint ao final de cada execução completa, informando o tempo total economizado."
            >
              {!draft.id ? (
                <p className="text-sm text-slate-500 dark:text-zinc-400">
                  Salve a automação primeiro para gerar uma chave de API.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">Endpoint</p>
                    <code className="mt-1 block break-all font-mono text-sm text-slate-800 dark:text-zinc-200">
                      POST {window.location.origin}/api/integrations/time-savings
                    </code>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">Exemplo de payload</p>
                    <pre className="mt-1 overflow-x-auto font-mono text-xs text-slate-800 dark:text-zinc-200">
{`{
  "secondsSaved": 1800,
  "userLogin": "FULANO",
  "unitsProcessed": 42,
  "externalId": "lote-2026-07-21-01"
}`}
                    </pre>
                    <p className="mt-2 text-xs text-slate-500 dark:text-zinc-400">
                      Header <code>Authorization: Bearer &lt;chave de API&gt;</code>. <code>userLogin</code> é usado
                      para vincular o crédito ao usuário do hub pelo login; <code>externalId</code> é opcional e
                      evita contar o mesmo lote duas vezes em caso de reenvio.
                    </p>
                  </div>

                  {generatedApiKey ? (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
                      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                        Copie a chave agora — ela não será mostrada novamente.
                      </p>
                      <code className="mt-2 block break-all rounded-lg bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:bg-black/30 dark:text-zinc-100">
                        {generatedApiKey}
                      </code>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
                    <span className="text-sm text-slate-600 dark:text-zinc-300">
                      {selectedRobot?.hasApiKey ? 'Chave de API configurada.' : 'Nenhuma chave de API configurada ainda.'}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isManagingApiKey}
                        onClick={() => void handleGenerateApiKey()}
                      >
                        {selectedRobot?.hasApiKey ? 'Gerar nova chave' : 'Gerar chave de API'}
                      </Button>
                      {selectedRobot?.hasApiKey ? (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={isManagingApiKey}
                          onClick={() => void handleRevokeApiKey()}
                        >
                          Revogar
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </Section>
          ) : (
          <Section
            title="Script da automação"
            description="Suba um .zip ou .rar com todos os scripts Python. O hub configura o comando de execução automaticamente."
          >
            <div className="grid grid-cols-1 gap-4">
              {draft.workingDirectory?.replace(/\\/g, '/').includes('/scripts') ? (
                <div className="flex items-center justify-between gap-3 rounded-2xl bg-emerald-50 px-4 py-3 dark:bg-emerald-950/30">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Scripts ativos</p>
                      <p className="truncate font-mono text-xs text-emerald-600 dark:text-emerald-400">
                        {draft.command?.replace(/^python3?\s+/, '') ?? ''}
                      </p>
                      {draft.scriptFileName ? (
                        <p className="truncate text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">
                          {draft.scriptFileName}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {draft.scriptFileName && draft.id ? (
                    <button
                      type="button"
                      onClick={() =>
                        void downloadWithFeedback(
                          `/storage/robots/${draft.id}/scripts/_upload.zip`,
                          draft.scriptFileName || '_upload.zip',
                          notify,
                        )
                      }
                      className="flex-shrink-0 rounded-xl border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60"
                    >
                      Baixar
                    </button>
                  ) : null}
                </div>
              ) : null}

              {pipStatus === 'installing' && (
                <div className="flex items-center gap-3 rounded-2xl bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
                  <svg className="h-4 w-4 flex-shrink-0 animate-spin text-amber-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Instalando dependências... aguarde antes de executar.</p>
                </div>
              )}
              {pipStatus === 'done' && (
                <div className="flex items-center gap-3 rounded-2xl bg-emerald-50 px-4 py-3 dark:bg-emerald-950/30">
                  <div className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
                  <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Dependências instaladas. Pronto para executar.</p>
                </div>
              )}
              {pipStatus === 'error' && (
                <div className="flex items-center gap-3 rounded-2xl bg-red-50 px-4 py-3 dark:bg-red-950/30">
                  <div className="h-2 w-2 flex-shrink-0 rounded-full bg-red-500" />
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">Erro ao instalar dependências. Verifique o requirements.txt.</p>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Arquivo (.zip ou .rar)">
                  <Input
                    type="file"
                    accept=".zip,.rar"
                    onChange={(event) => setScriptFile(event.target.files?.[0] ?? null)}
                  />
                </Field>
                <Field label="Script principal" hint="Arquivo que inicia a automação, ex: main.py">
                  <Input
                    value={scriptEntryScript}
                    placeholder="main.py"
                    onChange={(event) => setScriptEntryScript(event.target.value)}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between gap-3">
                {!draft.id ? (
                  <p className="text-xs text-slate-400 dark:text-zinc-500">
                    O arquivo será enviado automaticamente ao salvar.
                  </p>
                ) : <span />}
                {draft.id ? (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!draft.id) return;
                      if (!scriptFile) {
                        notify('Selecione um arquivo .zip ou .rar para enviar.');
                        return;
                      }
                      if (!scriptEntryScript.trim()) {
                        notify('Informe o script principal (ex: main.py).');
                        return;
                      }
                      try {
                        const formData = new FormData();
                        formData.append('file', scriptFile);
                        formData.append('entryScript', scriptEntryScript.trim());
                        const updated = await api<Robot>(`/robots/${draft.id}/scripts`, {
                          method: 'POST',
                          body: formData,
                        });
                        setDraft((prev) => ({ ...prev, command: updated.command ?? prev.command, workingDirectory: updated.workingDirectory ?? prev.workingDirectory }));
                        await refreshHub();
                        setScriptFile(null);
                        setScriptEntryScript('');
                        notify('Scripts enviados com sucesso.');
                        startPipStatusPolling(draft.id);
                      } catch (error) {
                        notify(error instanceof Error ? error.message : 'Não foi possível enviar os scripts.');
                      }
                    }}
                  >
                    {draft.workingDirectory?.includes('/scripts') ? 'Substituir scripts' : 'Enviar scripts'}
                  </Button>
                ) : null}
              </div>
            </div>
          </Section>
          )}

          <Section
            title="Métrica de tempo ganho"
            description={
              draft.isExternal
                ? 'Para automações externas, quem envia o tempo total economizado é o próprio sistema, a cada chamada da API — o campo abaixo é ignorado. "Nome da unidade" continua valendo só para exibição nos relatórios.'
                : 'Defina quanto tempo o processo manual levaria para calcular automaticamente a economia.'
            }
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Tempo manual por unidade (segundos)" hint={draft.isExternal ? 'Ignorado para automações externas.' : undefined}>
                <Input
                  type="number"
                  min="0"
                  disabled={draft.isExternal}
                  value={draft.manualSecondsPerUnit}
                  onChange={(event) =>
                    setDraft({ ...draft, manualSecondsPerUnit: event.target.value })
                  }
                />
              </Field>
              <Field label="Nome da unidade">
                <Input
                  value={draft.unitLabel}
                  placeholder="Ex: empresa, nota, cliente"
                  onChange={(event) => setDraft({ ...draft, unitLabel: event.target.value })}
                />
              </Field>
              <Field className="md:col-span-2" label="Chave da métrica no robô">
                <Input
                  value={draft.unitMetricKey}
                  placeholder="Ex: itens_processados (AH_METRIC|itens_processados|100)"
                  onChange={(event) =>
                    setDraft({ ...draft, unitMetricKey: event.target.value })
                  }
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Recursos e suporte"
            description={
              draft.isExternal
                ? 'Para automações externas, use o link abaixo para indicar onde a pessoa deve ir para efetivamente usar esse robô — ele aparece como um botão na tela da automação.'
                : 'Informações complementares exibidas para o usuário final.'
            }
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={draft.isExternal ? 'Texto do botão' : 'Label da documentação'} hint={draft.isExternal ? 'Ex: "Acessar BI Financeiro"' : undefined}>
                <Input
                  value={draft.documentationLabel}
                  placeholder={draft.isExternal ? 'Acessar BI Financeiro' : undefined}
                  onChange={(e) => setDraft({ ...draft, documentationLabel: e.target.value })}
                />
              </Field>
              <Field className="md:col-span-2" label={draft.isExternal ? 'Link do site onde o robô é usado' : 'Link da documentação'}>
                <Input
                  value={draft.documentationUrl}
                  placeholder={draft.isExternal ? 'https://...' : undefined}
                  onChange={(e) => setDraft({ ...draft, documentationUrl: e.target.value })}
                />
              </Field>
              <Field label="Label do suporte">
                <Input value={draft.supportLabel} onChange={(e) => setDraft({ ...draft, supportLabel: e.target.value })} />
              </Field>
              <Field label="Contato do suporte">
                <Input value={draft.supportValue} onChange={(e) => setDraft({ ...draft, supportValue: e.target.value })} />
              </Field>
              <Field className="md:col-span-2" label="Política de dados">
                <Textarea value={draft.dataPolicy} onChange={(e) => setDraft({ ...draft, dataPolicy: e.target.value })} />
              </Field>
            </div>
          </Section>

          <BuilderSection
            title="Campos do formulário"
            description="Monte os parâmetros que o usuário deverá preencher antes de executar o robô."
            onAdd={() =>
              setDraft((current) => ({
                ...current,
                fields: [
                  ...current.fields,
                  { name: '', label: '', type: 'text', required: false, placeholder: '', options: [], defaultValue: '' },
                ],
              }))
            }
          >
            {draft.fields.map((field, index) => (
              <FieldBuilderRow
                key={`field-${index}`}
                field={field}
                onChange={(next) =>
                  setDraft((current) => ({
                    ...current,
                    fields: current.fields.map((item, itemIndex) => (itemIndex === index ? next : item)),
                  }))
                }
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    fields: current.fields.filter((_, itemIndex) => itemIndex !== index),
                  }))
                }
              />
            ))}
          </BuilderSection>

          <BuilderSection
            title="Uploads de arquivo"
            description="Configure arquivos obrigatórios ou opcionais enviados pelo usuário."
            onAdd={() =>
              setDraft((current) => ({
                ...current,
                fileInputs: [
                  ...current.fileInputs,
                  { name: '', label: '', accept: '', multiple: false, required: false, helperText: '' },
                ],
              }))
            }
          >
            {draft.fileInputs.map((fileInput, index) => (
              <FileInputBuilderRow
                key={`file-${index}`}
                fileInput={fileInput}
                onChange={(next) =>
                  setDraft((current) => ({
                    ...current,
                    fileInputs: current.fileInputs.map((item, itemIndex) => (itemIndex === index ? next : item)),
                  }))
                }
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    fileInputs: current.fileInputs.filter((_, itemIndex) => itemIndex !== index),
                  }))
                }
              />
            ))}
          </BuilderSection>

          <Section
            title="Modelos de entrada"
            description="Anexe arquivos-exemplo e instruções para o usuário preencher os uploads corretamente."
          >
            {draft.id ? (
              <div className="grid grid-cols-1 gap-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Arquivo modelo">
                    <Input
                      type="file"
                      onChange={(event) => setExampleFile(event.target.files?.[0] ?? null)}
                    />
                  </Field>
                  <Field label="Relacionado ao upload">
                    <select
                      className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                      value={exampleInputName}
                      onChange={(event) => setExampleInputName(event.target.value)}
                    >
                      <option value="">Geral (vale para qualquer upload)</option>
                      {draft.fileInputs.map((fileInput) => (
                        <option key={fileInput.name} value={fileInput.name}>
                          {fileInput.label || fileInput.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Título">
                    <Input
                      value={exampleTitle}
                      placeholder="Ex: Planilha de notas fiscais"
                      onChange={(event) => setExampleTitle(event.target.value)}
                    />
                  </Field>
                  <Field className="md:col-span-2" label="Instruções">
                    <Textarea
                      value={exampleDescription}
                      placeholder="Ex: Deve conter as colunas CNPJ, UF e Valor."
                      onChange={(event) => setExampleDescription(event.target.value)}
                    />
                  </Field>
                </div>

                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!draft.id) return;
                      if (!exampleFile) {
                        notify('Selecione um arquivo modelo para enviar.');
                        return;
                      }

                      try {
                        const formData = new FormData();
                        formData.append('file', exampleFile);
                        if (exampleInputName) formData.append('fileInputName', exampleInputName);
                        if (exampleTitle.trim()) formData.append('title', exampleTitle.trim());
                        if (exampleDescription.trim()) {
                          formData.append('description', exampleDescription.trim());
                        }

                        await api(`/robots/${draft.id}/examples`, {
                          method: 'POST',
                          body: formData,
                        });
                        await refreshHub();
                        setExampleFile(null);
                        setExampleInputName('');
                        setExampleTitle('');
                        setExampleDescription('');
                        notify('Modelo de entrada enviado.');
                      } catch (error) {
                        notify(error instanceof Error ? error.message : 'Não foi possível enviar o modelo.');
                      }
                    }}
                  >
                    Enviar modelo
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {(selectedRobot?.inputExamples ?? []).length > 0 ? (
                    selectedRobot?.inputExamples?.map((example) => (
                      <InputExampleRow
                        key={example.id}
                        example={example}
                        onDelete={async () => {
                          if (!draft.id) return;
                          try {
                            await api(`/robots/${draft.id}/examples/${example.id}`, {
                              method: 'DELETE',
                            });
                            await refreshHub();
                            notify('Modelo removido.');
                          } catch (error) {
                            notify(error instanceof Error ? error.message : 'Não foi possível remover o modelo.');
                          }
                        }}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-slate-500 dark:text-zinc-400">
                      Nenhum modelo anexado.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500 dark:text-zinc-400">
                Salve a automação primeiro para anexar modelos de arquivo.
              </p>
            )}
          </Section>

          <div className="flex justify-end">
            <Button disabled={isSavingRobot} onClick={handleSaveRobot}>
              {isSavingRobot ? 'Salvando...' : 'Salvar automação'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function renderSitesTab({
  draft,
  selectedSite,
  setDraft,
  isSavingSite,
  setIsSavingSite,
  isCheckingSite,
  setIsCheckingSite,
  faviconFile,
  setFaviconFile,
  isSavingFavicon,
  setIsSavingFavicon,
  faviconVersion,
  setFaviconVersion,
  loadSites,
  setSelectedSiteId,
  notify,
}: {
  draft: SiteDraft;
  selectedSite: Site | null;
  setDraft: React.Dispatch<React.SetStateAction<SiteDraft>>;
  isSavingSite: boolean;
  setIsSavingSite: React.Dispatch<React.SetStateAction<boolean>>;
  isCheckingSite: boolean;
  setIsCheckingSite: React.Dispatch<React.SetStateAction<boolean>>;
  faviconFile: File | null;
  setFaviconFile: React.Dispatch<React.SetStateAction<File | null>>;
  isSavingFavicon: boolean;
  setIsSavingFavicon: React.Dispatch<React.SetStateAction<boolean>>;
  faviconVersion: number;
  setFaviconVersion: React.Dispatch<React.SetStateAction<number>>;
  loadSites: () => Promise<void>;
  setSelectedSiteId: (value: string | null) => void;
  notify: (message: string) => void;
}) {
  async function handleSaveSite() {
    if (isSavingSite) return;
    setIsSavingSite(true);
    try {
      const saved = await api<Site>('/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: draft.id,
          name: draft.name,
          url: draft.url,
          description: draft.description,
          category: draft.category,
          maintenanceOverride: draft.maintenanceOverride,
          allowedDepartments: draft.allowedDepartments,
          minRole: draft.minRole,
          powerbiGroupId: draft.category === 'bi' ? draft.powerbiGroupId : '',
          powerbiDatasetId: draft.category === 'bi' ? draft.powerbiDatasetId : '',
          powerbiScheduledTimes: draft.category === 'bi' ? draft.powerbiScheduledTimes : [],
          powerbiShowRefresh: draft.powerbiShowRefresh,
          ssoEnabled: draft.ssoEnabled,
        }),
      });
      await loadSites();
      setSelectedSiteId(saved.id);
      notify('Site salvo com sucesso.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar o site.');
    } finally {
      setIsSavingSite(false);
    }
  }

  return (
    <Card className="rounded-3xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>{draft.id ? draft.name || 'Site' : 'Novo site'}</CardTitle>
          <CardDescription>Cadastre o nome, a URL e o status de manutenção do site.</CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {selectedSite ? (
            <>
              <Badge variant={siteStatusVariant(selectedSite.status)} className="gap-1.5">
                <StatusDot status={selectedSite.status} />
                {siteStatusLabel(selectedSite.status)}
              </Badge>
              <span className="text-xs text-slate-500 dark:text-zinc-400">
                Verificado {timeAgo(selectedSite.lastCheckedAt).toLowerCase()}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={isCheckingSite}
                onClick={async () => {
                  if (isCheckingSite || !selectedSite) return;
                  setIsCheckingSite(true);
                  try {
                    const updated = await api<Site>(`/sites/${selectedSite.id}/check`, { method: 'POST' });
                    await loadSites();
                    notify(`Site verificado: ${siteStatusLabel(updated.status)}.`);
                  } catch (error) {
                    notify(error instanceof Error ? error.message : 'Não foi possível verificar o site.');
                  } finally {
                    setIsCheckingSite(false);
                  }
                }}
              >
                <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isCheckingSite ? 'animate-spin' : ''}`} />
                {isCheckingSite ? 'Verificando...' : 'Verificar agora'}
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="outline" disabled={isSavingSite} onClick={handleSaveSite}>
            {isSavingSite ? 'Salvando...' : 'Salvar'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Nome">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="URL" hint="Endereço completo, com https://">
            <Input
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="https://exemplo.com.br"
            />
          </Field>
          <Field label="Categoria" hint="Usado pra filtrar em /sites">
            <select
              className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value as SiteCategory })}
            >
              {(['sistema', 'bi'] as SiteCategory[]).map((category) => (
                <option key={category} value={category}>
                  {siteCategoryLabel(category)}
                </option>
              ))}
            </select>
          </Field>
          <Field className="md:col-span-2" label="Descrição">
            <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
        </div>

        {draft.category === 'bi' ? (
          <div className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-300 p-4 dark:border-[#2b2b31]">
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-zinc-200">Power BI — atualização de dados</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                Preencha para habilitar o botão "Atualizar dados" na página de sites. Os IDs ficam na URL do Power BI
                (app.powerbi.com/groups/<strong>GROUP_ID</strong>/datasets/<strong>DATASET_ID</strong>).
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Group ID (Workspace ID)">
                <Input
                  value={draft.powerbiGroupId}
                  onChange={(e) => setDraft({ ...draft, powerbiGroupId: e.target.value })}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
              </Field>
              <Field label="Dataset ID">
                <Input
                  value={draft.powerbiDatasetId}
                  onChange={(e) => setDraft({ ...draft, powerbiDatasetId: e.target.value })}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
              </Field>
            </div>
            <Field label="Horários de atualização agendada" hint="Apenas informativo — horários que você configurou no próprio Power BI.">
              <BiScheduleField
                times={draft.powerbiScheduledTimes}
                onChange={(times) => setDraft({ ...draft, powerbiScheduledTimes: times })}
              />
            </Field>
            <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 transition hover:bg-slate-50 dark:border-[#2b2b31] dark:hover:bg-white/[0.02]">
              <input
                type="checkbox"
                checked={draft.powerbiShowRefresh}
                onChange={(e) => setDraft({ ...draft, powerbiShowRefresh: e.target.checked })}
              />
              <div>
                <div className="text-sm font-medium">Mostrar botão de atualizar</div>
                <div className="text-xs text-slate-500 dark:text-zinc-400">Quando desmarcado, o status de última atualização ainda é exibido, mas sem o botão de disparo manual.</div>
              </div>
            </label>
          </div>
        ) : null}

        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 transition hover:bg-slate-50 dark:border-[#2b2b31] dark:hover:bg-white/[0.02]">
          <input
            type="checkbox"
            checked={draft.ssoEnabled}
            onChange={(e) => setDraft({ ...draft, ssoEnabled: e.target.checked })}
          />
          <div>
            <div className="text-sm font-medium">Login automático via Hub (SSO)</div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">Quando ativado, ao clicar em "Abrir" o hub gera um token temporário (30s) e autentica o usuário automaticamente no site. O site precisa implementar o endpoint <code>/hub-sso/</code>.</div>
          </div>
        </label>

        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-300 p-4 dark:border-[#2b2b31]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-slate-700 dark:text-zinc-200">Favicon</span>
            {selectedSite?.hasFavicon ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (!draft.id) return;
                  try {
                    await api(`/sites/${draft.id}/favicon`, { method: 'DELETE' });
                    await loadSites();
                    setFaviconVersion((value) => value + 1);
                    notify('Favicon customizado removido.');
                  } catch (error) {
                    notify(error instanceof Error ? error.message : 'Não foi possível remover o favicon.');
                  }
                }}
              >
                Remover
              </Button>
            ) : null}
          </div>

          {draft.id ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl border border-slate-200 bg-slate-50 dark:border-[#2b2b31] dark:bg-[#0f0f10]">
                <SiteFavicon key={`${draft.id}-${faviconVersion}`} siteId={draft.id} className="h-5 w-5" />
              </div>
              <div className="grid min-w-[200px] flex-1 gap-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFaviconFile(e.target.files?.[0] ?? null)}
                  className="text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200 dark:text-zinc-300 dark:file:bg-[#18181b] dark:file:text-zinc-100"
                />
                <span className="text-xs text-slate-500 dark:text-zinc-400">
                  Opcional — se não enviar, o hub tenta buscar automaticamente ou mostra um ícone padrão.
                </span>
              </div>
              {faviconFile ? (
                <Button
                  size="sm"
                  disabled={isSavingFavicon}
                  onClick={async () => {
                    if (!draft.id || !faviconFile) return;
                    setIsSavingFavicon(true);
                    try {
                      const formData = new FormData();
                      formData.append('file', faviconFile);
                      await api(`/sites/${draft.id}/favicon`, { method: 'POST', body: formData });
                      await loadSites();
                      setFaviconFile(null);
                      setFaviconVersion((value) => value + 1);
                      notify('Favicon atualizado.');
                    } catch (error) {
                      notify(error instanceof Error ? error.message : 'Não foi possível enviar o favicon.');
                    } finally {
                      setIsSavingFavicon(false);
                    }
                  }}
                >
                  {isSavingFavicon ? 'Enviando...' : 'Enviar'}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-zinc-400">
              Salve o site primeiro para enviar um favicon customizado.
            </p>
          )}
        </div>

        <label className="flex items-center gap-3 rounded-2xl border border-slate-300 px-4 py-3 text-sm dark:border-[#2b2b31]">
          <input
            type="checkbox"
            checked={draft.maintenanceOverride}
            onChange={(e) => setDraft({ ...draft, maintenanceOverride: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
          />
          Colocar em manutenção manualmente (ignora a verificação automática enquanto ativo)
        </label>

        <div className="grid gap-4">
          <div>
            <p className="text-sm font-medium text-slate-700 dark:text-zinc-200">Quem pode ver este site</p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">Deixe todos desmarcados para liberar para todos os departamentos.</p>
          </div>
          <DepartmentPicker
            selected={draft.allowedDepartments}
            onToggle={(dept) => {
              const next = draft.allowedDepartments.includes(dept)
                ? draft.allowedDepartments.filter((d) => d !== dept)
                : [...draft.allowedDepartments, dept];
              setDraft({ ...draft, allowedDepartments: next });
            }}
          />
          <div className="flex gap-2">
            {(['employee', 'manager'] as const).map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => setDraft({ ...draft, minRole: role })}
                className={[
                  'rounded-xl border px-4 py-2 text-sm font-medium transition',
                  draft.minRole === role
                    ? 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-900/30 dark:text-sky-300'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b]',
                ].join(' ')}
              >
                {role === 'employee' ? 'Funcionários e gestores' : 'Somente gestores'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <Button disabled={isSavingSite} onClick={handleSaveSite}>
            {isSavingSite ? 'Salvando...' : 'Salvar site'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DepartmentSummary({ departments: userDepts }: { departments: Department[] }) {
  const { departments } = useHub();
  if (userDepts.length === 0) {
    return <span className="text-sm text-slate-400 dark:text-zinc-500">Todos</span>;
  }

  const visible = userDepts.slice(0, 2);
  const overflow = userDepts.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((dept) => (
        <Badge key={dept} variant="muted">
          {departmentLabel(dept, departments)}
        </Badge>
      ))}
      {overflow > 0 ? <Badge variant="muted">+{overflow}</Badge> : null}
    </div>
  );
}

function NewUserCard({
  isOpen,
  onOpenChange,
  notify,
  loadUsers,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  notify: (message: string) => void;
  loadUsers: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<NewUserDraft>(emptyNewUserDraft());
  const [isSaving, setIsSaving] = useState(false);

  if (!isOpen) {
    return null;
  }

  function toggleDepartment(department: Department) {
    setDraft((current) => ({
      ...current,
      departments: current.departments.includes(department)
        ? current.departments.filter((entry) => entry !== department)
        : [...current.departments, department],
    }));
  }

  async function handleCreate() {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await api('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      notify(`Usuário ${draft.name} criado.`);
      setDraft(emptyNewUserDraft());
      onOpenChange(false);
      await loadUsers();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível criar o usuário.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Novo usuário
        </CardTitle>
        <CardDescription>A conta já nasce ativa — sem precisar de aprovação separada.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Nome">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          <Field label="Senha" hint="Mínimo de 6 caracteres.">
            <PasswordInput value={draft.password} onChange={(value) => setDraft({ ...draft, password: value })} />
          </Field>
          <Field label="Hierarquia">
            <select
              className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
              value={draft.role}
              onChange={(event) => setDraft({ ...draft, role: event.target.value as UserRole })}
            >
              {(['admin', 'manager', 'employee'] as UserRole[]).map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </Field>
          <Field className="md:col-span-2" label="Departamentos" hint="Se nada for marcado, o usuário enxerga automações de todos os departamentos.">
            <DepartmentPicker selected={draft.departments} onToggle={toggleDepartment} />
          </Field>
        </div>
        <div className="flex justify-end gap-3">
          <Button
            variant="outline"
            disabled={isSaving}
            onClick={() => {
              setDraft(emptyNewUserDraft());
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button disabled={isSaving} onClick={() => void handleCreate()}>
            {isSaving ? 'Criando...' : 'Criar usuário'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function renderUsersTab({
  users,
  linkableUsers,
  notify,
  loadUsers,
  editingUserId,
  setEditingUserId,
  closingUserId,
  setClosingUserId,
  userDraft,
  setUserDraft,
  isSavingUser,
  setIsSavingUser,
}: {
  users: ManagedUser[];
  linkableUsers: ManagedUser[];
  notify: (message: string) => void;
  loadUsers: () => Promise<void>;
  editingUserId: string | null;
  setEditingUserId: (value: string | null) => void;
  closingUserId: string | null;
  setClosingUserId: (value: string | null) => void;
  userDraft: UserDraft | null;
  setUserDraft: React.Dispatch<React.SetStateAction<UserDraft | null>>;
  isSavingUser: boolean;
  setIsSavingUser: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const localUsers = users.filter((managedUser) => !managedUser.athenasLogin);
  const athenasUsers = users.filter((managedUser) => managedUser.athenasLogin);

  const shared = {
    notify,
    loadUsers,
    editingUserId,
    setEditingUserId,
    closingUserId,
    setClosingUserId,
    userDraft,
    setUserDraft,
    isSavingUser,
    setIsSavingUser,
  };

  return (
    <div className="grid grid-cols-1 gap-5">
      <UnlinkedIdentitiesCard users={linkableUsers} notify={notify} />
      <UsersSection
        title="Usuários locais"
        description="Contas criadas direto no hub. Clique em editar para ajustar nome, senha, hierarquia, status e departamentos."
        users={localUsers}
        allowNameAndPassword
        {...shared}
      />
      <UsersSection
        title="Usuários Athenas (SSO)"
        description="Sincronizados pelo login corporativo a cada acesso — nome e senha vêm do Athenas e não são editáveis aqui."
        users={athenasUsers}
        allowNameAndPassword={false}
        {...shared}
      />
    </div>
  );
}

function UsersSection({
  title,
  description,
  users,
  allowNameAndPassword,
  notify,
  loadUsers,
  editingUserId,
  setEditingUserId,
  closingUserId,
  setClosingUserId,
  userDraft,
  setUserDraft,
  isSavingUser,
  setIsSavingUser,
}: {
  title: string;
  description: string;
  users: ManagedUser[];
  allowNameAndPassword: boolean;
  notify: (message: string) => void;
  loadUsers: () => Promise<void>;
  editingUserId: string | null;
  setEditingUserId: (value: string | null) => void;
  closingUserId: string | null;
  setClosingUserId: (value: string | null) => void;
  userDraft: UserDraft | null;
  setUserDraft: React.Dispatch<React.SetStateAction<UserDraft | null>>;
  isSavingUser: boolean;
  setIsSavingUser: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  function startEditing(managedUser: ManagedUser) {
    setClosingUserId(null);
    setEditingUserId(managedUser.id);
    setUserDraft({
      name: managedUser.name,
      password: '',
      role: managedUser.role,
      departments: managedUser.departments,
      isActive: managedUser.isActive,
    });
  }

  function cancelEditing() {
    setClosingUserId(editingUserId);
    setEditingUserId(null);
    setTimeout(() => {
      setUserDraft(null);
      setClosingUserId(null);
    }, 320);
  }

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {users.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500 dark:text-zinc-400">
            Nenhuma conta encontrada para a busca atual.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Usuário</TableHead>
                <TableHead>Departamentos</TableHead>
                <TableHead>Hierarquia</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((managedUser) => {
                const isEditing = editingUserId === managedUser.id && Boolean(userDraft);
                return (
                  <>
                    <TableRow key={managedUser.id} className={isEditing ? 'border-b-0' : ''}>
                      <TableCell>
                        <div className="font-medium text-slate-950 dark:text-white">{managedUser.name}</div>
                        <div className="text-xs text-slate-500 dark:text-zinc-400">{managedUser.email}</div>
                      </TableCell>
                      <TableCell>
                        <DepartmentSummary departments={managedUser.departments} />
                      </TableCell>
                      <TableCell>{ROLE_LABELS[managedUser.role]}</TableCell>
                      <TableCell>
                        <Badge variant={managedUser.isActive ? 'success' : 'muted'}>
                          {managedUser.isActive ? 'Ativo' : 'Inativo'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {isEditing ? (
                          <Button variant="outline" size="sm" disabled={isSavingUser} onClick={cancelEditing}>
                            Cancelar
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => startEditing(managedUser)}>
                            Editar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    <TableRow key={`${managedUser.id}-edit`} className="hover:bg-transparent dark:hover:bg-transparent">
                      <TableCell colSpan={5} className="p-0">
                        <div
                          className="grid transition-all duration-300 ease-out"
                          style={{ gridTemplateRows: isEditing ? '1fr' : '0fr' }}
                        >
                          <div className="overflow-hidden">
                            {userDraft && (isEditing || closingUserId === managedUser.id) ? (
                              <div className="grid grid-cols-1 gap-4 px-4 pb-5 pt-2">
                                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                  {allowNameAndPassword ? (
                                    <>
                                      <Field label="Nome">
                                        <Input
                                          value={userDraft.name}
                                          onChange={(event) => setUserDraft({ ...userDraft, name: event.target.value })}
                                        />
                                      </Field>
                                      <Field label="Nova senha" hint="Deixe em branco para manter a senha atual.">
                                        <PasswordInput
                                          value={userDraft.password}
                                          onChange={(value) => setUserDraft({ ...userDraft, password: value })}
                                        />
                                      </Field>
                                    </>
                                  ) : null}
                                  <Field label="Hierarquia">
                                    <select
                                      className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                                      value={userDraft.role}
                                      onChange={(event) =>
                                        setUserDraft({ ...userDraft, role: event.target.value as UserRole })
                                      }
                                    >
                                      {(['admin', 'manager', 'employee'] as UserRole[]).map((role) => (
                                        <option key={role} value={role}>
                                          {ROLE_LABELS[role]}
                                        </option>
                                      ))}
                                    </select>
                                  </Field>
                                  <Field label="Status">
                                    <select
                                      className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                                      value={String(userDraft.isActive)}
                                      onChange={(event) =>
                                        setUserDraft({ ...userDraft, isActive: event.target.value === 'true' })
                                      }
                                    >
                                      <option value="true">Ativo</option>
                                      <option value="false">Inativo</option>
                                    </select>
                                  </Field>
                                  <Field className="md:col-span-2" label="Departamentos" hint="Se nada for marcado, o usuário enxerga automações de todos os departamentos.">
                                    <DepartmentPicker
                                      selected={userDraft.departments}
                                      onToggle={(department) =>
                                        setUserDraft((current) =>
                                          current
                                            ? {
                                                ...current,
                                                departments: current.departments.includes(department)
                                                  ? current.departments.filter((entry) => entry !== department)
                                                  : [...current.departments, department],
                                              }
                                            : current,
                                        )
                                      }
                                    />
                                  </Field>
                                </div>
                                <div className="flex justify-end gap-3">
                                  <Button variant="outline" disabled={isSavingUser} onClick={cancelEditing}>
                                    Cancelar
                                  </Button>
                                  <Button
                                    disabled={isSavingUser}
                                    onClick={async () => {
                                      if (isSavingUser) return;
                                      setIsSavingUser(true);
                                      try {
                                        const body: Record<string, unknown> = {
                                          role: userDraft.role,
                                          departments: userDraft.departments,
                                          isActive: userDraft.isActive,
                                        };
                                        if (allowNameAndPassword) {
                                          body.name = userDraft.name;
                                          if (userDraft.password) {
                                            body.password = userDraft.password;
                                          }
                                        }
                                        await api(`/users/${managedUser.id}`, {
                                          method: 'PATCH',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify(body),
                                        });
                                        notify(`Acesso de ${managedUser.name} atualizado.`);
                                        cancelEditing();
                                        await loadUsers();
                                      } catch (error) {
                                        notify(error instanceof Error ? error.message : 'Não foi possível atualizar o usuário.');
                                      } finally {
                                        setIsSavingUser(false);
                                      }
                                    }}
                                  >
                                    {isSavingUser ? 'Salvando...' : 'Salvar acesso'}
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function UnlinkedIdentitiesCard({
  users,
  notify,
}: {
  users: ManagedUser[];
  notify: (message: string) => void;
}) {
  const [identities, setIdentities] = useState<UnlinkedExternalIdentity[]>([]);
  const [ignored, setIgnored] = useState<IgnoredIdentity[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [linkingLogin, setLinkingLogin] = useState<string | null>(null);
  const [togglingLogin, setTogglingLogin] = useState<string | null>(null);

  async function loadIdentities() {
    setLoading(true);
    try {
      const [unlinked, ignoredList] = await Promise.all([
        api<UnlinkedExternalIdentity[]>('/users/unlinked-identities'),
        api<IgnoredIdentity[]>('/users/ignored-identities'),
      ]);
      setIdentities(unlinked);
      setIgnored(ignoredList);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar as identidades sem vínculo.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadIdentities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ignoreIdentity(identity: UnlinkedExternalIdentity) {
    if (togglingLogin) return;
    setTogglingLogin(identity.login);
    try {
      await api('/users/unlinked-identities/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: identity.login, name: identity.receivedName }),
      });
      notify(`${identity.receivedName} marcado como teste — não vai mais aparecer nos relatórios.`);
      await loadIdentities();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível ignorar essa identidade.');
    } finally {
      setTogglingLogin(null);
    }
  }

  async function unignoreIdentity(identity: IgnoredIdentity) {
    if (togglingLogin) return;
    setTogglingLogin(identity.login);
    try {
      await api('/users/ignored-identities/unignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: identity.login }),
      });
      notify(`${identity.name} reativado — volta a aparecer nos relatórios.`);
      await loadIdentities();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível reativar essa identidade.');
    } finally {
      setTogglingLogin(null);
    }
  }

  async function linkIdentity(identity: UnlinkedExternalIdentity) {
    const userId = selection[identity.login];
    if (!userId || linkingLogin) return;

    setLinkingLogin(identity.login);
    try {
      const result = await api<{ linkedExecutions: number; userName: string }>(
        '/users/unlinked-identities/link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login: identity.login, userId }),
        },
      );
      notify(
        `${result.linkedExecutions} execução(ões) de ${identity.login} vinculada(s) a ${result.userName}.`,
      );
      await loadIdentities();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível vincular a identidade.');
    } finally {
      setLinkingLogin(null);
    }
  }

  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <CardTitle>Identidades externas sem vínculo</CardTitle>
        <CardDescription>
          Execuções recebidas antes de existir uma conta correspondente. Vincular não cria conta nem altera o histórico da execução.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="px-6 py-8 text-sm text-slate-500 dark:text-zinc-400">Carregando identidades...</p>
        ) : identities.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-500 dark:text-zinc-400">
            Todas as identidades externas estão vinculadas.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Identidade recebida</TableHead>
                <TableHead>Execuções</TableHead>
                <TableHead>Tempo acumulado</TableHead>
                <TableHead>Ocorrências</TableHead>
                <TableHead>Usuário de destino</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identities.map((identity) => (
                <TableRow key={identity.login}>
                  <TableCell>
                    <div className="font-medium text-slate-950 dark:text-white">{identity.receivedName}</div>
                    <div className="text-xs text-slate-500 dark:text-zinc-400">{identity.login}</div>
                  </TableCell>
                  <TableCell>{identity.executions}</TableCell>
                  <TableCell>{formatSecondsToHuman(identity.savedSeconds)}</TableCell>
                  <TableCell>
                    <div className="text-xs text-slate-600 dark:text-zinc-300">
                      Primeira: {timeAgo(identity.firstSeenAt)}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-zinc-400">
                      Última: {timeAgo(identity.lastSeenAt)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={`Usuário de destino para ${identity.login}`}
                      className="h-10 min-w-56 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                      value={selection[identity.login] ?? ''}
                      onChange={(event) =>
                        setSelection((current) => ({
                          ...current,
                          [identity.login]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Selecione uma conta</option>
                      {users.map((managedUser) => (
                        <option key={managedUser.id} value={managedUser.id}>
                          {managedUser.name} — {managedUser.email}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={togglingLogin !== null}
                        onClick={() => void ignoreIdentity(identity)}
                      >
                        {togglingLogin === identity.login ? 'Marcando...' : 'Marcar como teste'}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!selection[identity.login] || linkingLogin !== null}
                        onClick={() => void linkIdentity(identity)}
                      >
                        {linkingLogin === identity.login ? 'Vinculando...' : 'Vincular'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {ignored.length > 0 && (
        <>
          <Separator />
          <CardHeader>
            <CardTitle className="text-base">Identidades marcadas como teste</CardTitle>
            <CardDescription>
              Ficam de fora dos relatórios de tempo ganho e da lista acima. Reative se marcou alguma por engano.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Identidade</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ignored.map((identity) => (
                  <TableRow key={identity.login}>
                    <TableCell>
                      <div className="font-medium text-slate-950 dark:text-white">{identity.name}</div>
                      <div className="text-xs text-slate-500 dark:text-zinc-400">{identity.login}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={togglingLogin !== null}
                        onClick={() => void unignoreIdentity(identity)}
                      >
                        {togglingLogin === identity.login ? 'Reativando...' : 'Reativar'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </>
      )}
    </Card>
  );
}

function InputExampleRow({
  example,
  onDelete,
}: {
  example: RobotInputExample;
  onDelete: () => Promise<void>;
}) {
  const { notify } = useHub();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
      <div className="min-w-0 space-y-1">
        <div className="truncate text-sm font-medium">
          {example.title || userFileName(example.downloadName || example.filename)}
        </div>
        <div className="truncate text-xs text-slate-500 dark:text-zinc-400">
          {example.fileInputName ? `Upload: ${example.fileInputName}` : 'Modelo geral'}
        </div>
        {example.description ? (
          <p className="text-xs text-slate-500 dark:text-zinc-400">{example.description}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => void downloadWithFeedback(example.downloadUrl, userFileName(example.downloadName || example.filename), notify)}>
          Baixar
        </Button>
        <Button variant="danger" onClick={() => void onDelete()}>
          Remover
        </Button>
      </div>
    </div>
  );
}

function FieldBuilderRow({ field, onChange, onRemove }: { field: RobotSchemaField; onChange: (value: RobotSchemaField) => void; onRemove: () => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nome interno">
          <Input value={field.name} onChange={(e) => onChange({ ...field, name: e.target.value })} />
        </Field>
        <Field label="Label">
          <Input value={field.label} onChange={(e) => onChange({ ...field, label: e.target.value })} />
        </Field>
        <Field label="Tipo">
          <select
            className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
            value={field.type}
            onChange={(e) => onChange({ ...field, type: e.target.value })}
          >
            {['text', 'date', 'select', 'radio', 'checkbox-group', 'textarea', 'checkbox', 'serverpath'].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Valor padrão">
          <Input value={field.defaultValue || ''} onChange={(e) => onChange({ ...field, defaultValue: e.target.value })} />
        </Field>
        <Field className="md:col-span-2" label="Placeholder">
          <Input value={field.placeholder || ''} onChange={(e) => onChange({ ...field, placeholder: e.target.value })} />
        </Field>
        {field.type === 'serverpath' ? (
          <>
            <Field className="md:col-span-2" label="Pasta raiz (vista pelo servidor)">
              <Input
                value={field.rootPath || ''}
                placeholder="X:\DECON\CLIENTES\ADECE"
                onChange={(e) => onChange({ ...field, rootPath: e.target.value })}
              />
            </Field>
            <Field label="Escolher">
              <select
                className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                value={field.pick || 'folder'}
                onChange={(e) => onChange({ ...field, pick: e.target.value as 'file' | 'folder' })}
              >
                <option value="folder">Pasta</option>
                <option value="file">Arquivo</option>
              </select>
            </Field>
            <Field label="Extensões aceitas (arquivo)">
              <Input
                value={field.accept || ''}
                placeholder=".xlsx"
                onChange={(e) => onChange({ ...field, accept: e.target.value })}
              />
            </Field>
          </>
        ) : null}
        <Field className="md:col-span-2" label="Opções">
          <Input
            value={(field.options || []).join(', ')}
            onChange={(e) =>
              onChange({
                ...field,
                options: e.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={Boolean(field.required)} onChange={(e) => onChange({ ...field, required: e.target.checked })} />
            Obrigatório
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={Boolean(field.adminOnly)} onChange={(e) => onChange({ ...field, adminOnly: e.target.checked })} />
            Somente admin
          </label>
        </div>
        <Button variant="danger" onClick={onRemove}>
          Remover campo
        </Button>
      </div>
    </div>
  );
}

function FileInputBuilderRow({ fileInput, onChange, onRemove }: { fileInput: RobotSchemaFileInput; onChange: (value: RobotSchemaFileInput) => void; onRemove: () => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nome interno">
          <Input value={fileInput.name} onChange={(e) => onChange({ ...fileInput, name: e.target.value })} />
        </Field>
        <Field label="Label">
          <Input value={fileInput.label} onChange={(e) => onChange({ ...fileInput, label: e.target.value })} />
        </Field>
        <Field className="md:col-span-2" label="Tipos aceitos">
          <Input value={fileInput.accept || ''} onChange={(e) => onChange({ ...fileInput, accept: e.target.value })} />
        </Field>
        <Field className="md:col-span-2" label="Texto de ajuda">
          <Input value={fileInput.helperText || ''} onChange={(e) => onChange({ ...fileInput, helperText: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(fileInput.multiple)} onChange={(e) => onChange({ ...fileInput, multiple: e.target.checked })} />
            Permitir múltiplos arquivos
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={Boolean(fileInput.required)} onChange={(e) => onChange({ ...fileInput, required: e.target.checked })} />
            Obrigatório
          </label>
        </div>
        <Button variant="danger" onClick={onRemove}>
          Remover upload
        </Button>
      </div>
    </div>
  );
}

function renderDepartmentsTab({
  departments,
  selectedDeptId,
  setSelectedDeptId,
  deptDraft,
  setDeptDraft,
  isSavingDept,
  setIsSavingDept,
  confirmDeleteDeptId,
  setConfirmDeleteDeptId,
  notify,
  refreshDepartments,
  query,
  setQuery,
}: {
  departments: DepartmentConfig[];
  selectedDeptId: string | null;
  setSelectedDeptId: (id: string | null) => void;
  deptDraft: { name: string; slug: string };
  setDeptDraft: React.Dispatch<React.SetStateAction<{ name: string; slug: string }>>;
  isSavingDept: boolean;
  setIsSavingDept: React.Dispatch<React.SetStateAction<boolean>>;
  confirmDeleteDeptId: string | null;
  setConfirmDeleteDeptId: (id: string | null) => void;
  notify: (message: string) => void;
  refreshDepartments: () => Promise<void>;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
}) {
  const isCreating = selectedDeptId === 'new';
  const selectedDept = isCreating ? null : departments.find((d) => d.id === selectedDeptId) ?? null;
  const filtered = query.trim()
    ? departments.filter((d) => d.name.toLowerCase().includes(query.trim().toLowerCase()) || d.slug.includes(query.trim().toLowerCase()))
    : departments;

  function autoSlug(name: string) {
    return name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  async function handleSaveDept() {
    if (isSavingDept) return;
    if (!deptDraft.name.trim()) { notify('Informe o nome do departamento.'); return; }
    setIsSavingDept(true);
    try {
      if (isCreating) {
        await api('/departments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: deptDraft.name.trim(), slug: deptDraft.slug.trim() || undefined }),
        });
        notify('Departamento criado com sucesso.');
      } else {
        await api(`/departments/${selectedDeptId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: deptDraft.name.trim() }),
        });
        notify('Departamento atualizado.');
      }
      await refreshDepartments();
      setSelectedDeptId(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível salvar o departamento.');
    } finally {
      setIsSavingDept(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr] xl:items-start">
      <Card className="h-fit rounded-3xl">
        <CardHeader>
          <CardTitle>Departamentos</CardTitle>
          <CardDescription>Gerencie os departamentos da empresa. O slug é usado internamente para permissões.</CardDescription>
          <div className="relative pt-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="h-9 pl-9 text-sm" placeholder="Buscar departamento..." value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="max-h-[62vh] overflow-y-auto px-2 pb-2">
          {filtered.length === 0 && (
            <p className="px-2 py-1 text-sm text-slate-500 dark:text-zinc-400">
              Nenhum departamento encontrado.
            </p>
          )}
          {filtered.map((dept) => {
            const isSelected = dept.id === selectedDeptId;
            const isConfirmingDelete = confirmDeleteDeptId === dept.id;

            return (
              <div
                key={dept.id}
                className={[
                  'group flex items-start gap-2 rounded-xl px-2 py-2 transition',
                  isSelected
                    ? 'bg-slate-100 dark:bg-[#1b1b20]'
                    : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                ].join(' ')}
              >
                {/* name + slug */}
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelectedDeptId(dept.id)}
                >
                  <span className={`block text-sm font-medium leading-snug ${dept.isActive ? 'text-slate-900 dark:text-zinc-100' : 'text-slate-400 dark:text-zinc-500'}`}>
                    {dept.name}
                  </span>
                  <span className="block font-mono text-xs text-slate-400 dark:text-zinc-500">
                    {dept.slug}{!dept.isActive ? ' · Inativo' : ''}
                  </span>
                </button>

                {/* actions */}
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  {isConfirmingDelete ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteDeptId(null)}
                        className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                      >
                        Não
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api(`/departments/${dept.id}`, { method: 'DELETE' });
                            await refreshDepartments();
                            setConfirmDeleteDeptId(null);
                            if (selectedDeptId === dept.id) setSelectedDeptId(null);
                            notify(`Departamento "${dept.name}" excluído.`);
                          } catch (error) {
                            notify(error instanceof Error ? error.message : 'Não foi possível excluir o departamento.');
                            setConfirmDeleteDeptId(null);
                          }
                        }}
                        className="text-xs font-medium text-rose-500 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-300"
                      >
                        Excluir
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={`Editar "${dept.name}"`}
                        onClick={() => setSelectedDeptId(dept.id)}
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-600 dark:hover:bg-white/5 dark:hover:text-zinc-300"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Excluir departamento "${dept.name}"`}
                        onClick={() => setConfirmDeleteDeptId(dept.id)}
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 dark:text-zinc-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="xl:sticky xl:top-[77px] xl:max-h-[calc(100vh-93px)] xl:overflow-y-auto xl:rounded-3xl xl:pb-2">
      {!selectedDeptId ? (
        <Card className="rounded-3xl">
          <CardContent className="grid grid-cols-1 justify-items-center gap-3 py-16 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-[#18181b] dark:text-zinc-500">
              <Building2 className="h-6 w-6" />
            </div>
            <div className="grid gap-1">
              <p className="font-medium text-slate-900 dark:text-white">Nenhum departamento selecionado</p>
              <p className="text-sm text-slate-500 dark:text-zinc-400">Escolha um departamento à esquerda para editar, ou crie um novo.</p>
            </div>
            <Button className="mt-2" onClick={() => setSelectedDeptId('new')}>
              <Plus className="mr-2 h-4 w-4" />
              Novo departamento
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-3xl">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>{isCreating ? 'Novo departamento' : `Editar: ${selectedDept?.name ?? ''}`}</CardTitle>
              <CardDescription>
                {isCreating
                  ? 'O slug é gerado automaticamente a partir do nome e identifica o departamento nas permissões.'
                  : 'Edite o nome ou desative o departamento. O slug não pode ser alterado após a criação.'}
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" disabled={isSavingDept} onClick={handleSaveDept}>
              {isSavingDept ? 'Salvando...' : isCreating ? 'Criar' : 'Salvar'}
            </Button>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Nome">
                <Input
                  value={deptDraft.name}
                  placeholder="Ex: Jurídico"
                  onChange={(e) => {
                    const name = e.target.value;
                    setDeptDraft((prev) => ({
                      name,
                      slug: isCreating ? autoSlug(name) : prev.slug,
                    }));
                  }}
                />
              </Field>
              <Field label="Slug" hint={isCreating ? 'Identificador interno, gerado automaticamente.' : 'Não pode ser alterado.'}>
                <Input
                  value={deptDraft.slug}
                  placeholder="ex: juridico"
                  disabled={!isCreating}
                  onChange={(e) => isCreating && setDeptDraft((prev) => ({ ...prev, slug: e.target.value }))}
                  className={!isCreating ? 'cursor-not-allowed opacity-60' : ''}
                />
              </Field>
              {!isCreating && selectedDept ? (
                <Field label="Status">
                  <select
                    className="flex h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
                    value={String(selectedDept.isActive)}
                    onChange={async (e) => {
                      try {
                        await api(`/departments/${selectedDept.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ isActive: e.target.value === 'true' }),
                        });
                        await refreshDepartments();
                        notify('Status atualizado.');
                      } catch (error) {
                        notify(error instanceof Error ? error.message : 'Não foi possível atualizar o status.');
                      }
                    }}
                  >
                    <option value="true">Ativo</option>
                    <option value="false">Inativo</option>
                  </select>
                </Field>
              ) : null}
            </div>

            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setSelectedDeptId(null)}>
                Cancelar
              </Button>
              <Button disabled={isSavingDept} onClick={handleSaveDept}>
                {isSavingDept ? 'Salvando...' : isCreating ? 'Criar departamento' : 'Salvar alterações'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}

function StepperRow({
  label,
  description,
  value,
  format,
  onDecrement,
  onIncrement,
  canDecrement,
  canIncrement,
  disabled,
}: {
  label: string;
  description: string;
  value: number | null;
  format: (v: number) => string;
  onDecrement: () => void;
  onIncrement: () => void;
  canDecrement: boolean;
  canIncrement: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-slate-900 dark:text-zinc-100">{label}</div>
        <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{description}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || !canDecrement}
          onClick={onDecrement}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 disabled:opacity-40 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#1b1b20]"
        >
          −
        </button>
        <span className="min-w-[2.5rem] text-center text-base font-semibold tabular-nums text-slate-900 dark:text-zinc-100">
          {value !== null ? format(value) : '—'}
        </span>
        <button
          type="button"
          disabled={disabled || !canIncrement}
          onClick={onIncrement}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 disabled:opacity-40 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#1b1b20]"
        >
          +
        </button>
      </div>
    </div>
  );
}

function emptyDraft(): Draft {
  return {
    slug: '',
    name: '',
    summary: '',
    description: '',
    category: '',
    icon: 'bot',
    isActive: true,
    version: '1.0.0',
    maxConcurrency: '1',
    manualSecondsPerUnit: '0',
    unitLabel: 'item',
    unitMetricKey: 'itens_processados',
    conflictKeys: '',
    zipOutput: false,
    isExternal: false,
    command: '',
    workingDirectory: '',
    scriptFileName: '',
    allowedDepartments: [],
    documentationUrl: '',
    documentationLabel: 'Documentação',
    supportLabel: 'Suporte',
    supportValue: '',
    dataPolicy: '',
    fields: [],
    fileInputs: [],
  };
}

function emptySiteDraft(): SiteDraft {
  return {
    name: '',
    url: '',
    description: '',
    category: 'sistema',
    maintenanceOverride: false,
    allowedDepartments: [],
    minRole: 'employee',
    powerbiGroupId: '',
    powerbiDatasetId: '',
    powerbiScheduledTimes: [],
    powerbiShowRefresh: true,
    ssoEnabled: false,
  };
}

function mapSiteToDraft(site: Site): SiteDraft {
  return {
    id: site.id,
    name: site.name ?? '',
    url: site.url ?? '',
    description: site.description ?? '',
    category: site.category ?? 'sistema',
    maintenanceOverride: Boolean(site.maintenanceOverride),
    allowedDepartments: site.allowedDepartments ?? [],
    minRole: site.minRole ?? 'employee',
    powerbiGroupId: site.powerbiGroupId ?? '',
    powerbiDatasetId: site.powerbiDatasetId ?? '',
    powerbiScheduledTimes: site.powerbiScheduledTimes ?? [],
    powerbiShowRefresh: site.powerbiShowRefresh !== false,
    ssoEnabled: site.ssoEnabled === true,
  };
}

function mapRobotToDraft(robot: Robot): Draft {
  return {
    id: robot.id,
    slug: robot.slug ?? '',
    name: robot.name ?? '',
    summary: robot.summary ?? '',
    description: robot.description ?? '',
    category: robot.category ?? '',
    icon: robot.icon ?? 'bot',
    isActive: Boolean(robot.isActive),
    version: robot.version ?? '1.0.0',
    maxConcurrency: robot.maxConcurrency?.toString() ?? '1',
    manualSecondsPerUnit: robot.manualSecondsPerUnit?.toString() ?? '0',
    unitLabel: robot.unitLabel ?? 'item',
    unitMetricKey: robot.unitMetricKey ?? 'itens_processados',
    conflictKeys: robot.conflictKeys ?? '',
    zipOutput: Boolean(robot.zipOutput),
    isExternal: Boolean(robot.isExternal),
    command: robot.command ?? '',
    workingDirectory: robot.workingDirectory ?? '',
    scriptFileName: robot.scriptFileName ?? '',
    allowedDepartments: robot.allowedDepartments ?? [],
    documentationUrl: robot.documentationUrl ?? '',
    documentationLabel: robot.documentationLabel ?? 'Documentação',
    supportLabel: robot.supportLabel ?? 'Suporte',
    supportValue: robot.supportValue ?? '',
    dataPolicy: robot.dataPolicy ?? '',
    fields: Array.isArray(robot.schema?.fields) ? robot.schema.fields : [],
    fileInputs: Array.isArray(robot.schema?.fileInputs) ? robot.schema.fileInputs : [],
  };
}

function emptyDashboardDraft(): DashboardDraft {
  return {
    name: '',
    slug: '',
    description: '',
    type: 'html',
    isActive: true,
    allowedDepartments: [],
    minRole: 'employee',
    allowedUserIds: [],
    restrictToUsers: false,
    mainFile: 'index.html',
    serverCommand: '',
    serverWorkingDirectory: '',
    updatePath: '',
    warmupPaths: '',
    warmupMode: 'manual',
    updateFrequency: '',
    updateTimesOfDay: ['08:00'],
    updateDayOfWeek: '1',
    updateDayOfMonth: '1',
  };
}

function mapDashboardToDraft(d: Dashboard): DashboardDraft {
  return {
    id: d.id,
    name: d.name,
    slug: d.slug,
    description: d.description ?? '',
    type: d.type,
    isActive: d.isActive,
    allowedDepartments: d.allowedDepartments,
    minRole: d.minRole,
    allowedUserIds: d.allowedUserIds ?? [],
    restrictToUsers: (d.allowedUserIds ?? []).length > 0,
    mainFile: d.mainFile,
    serverCommand: d.serverCommand ?? '',
    serverWorkingDirectory: d.serverWorkingDirectory ?? '',
    updatePath: d.updatePath ?? '',
    warmupPaths: (d.warmupPaths ?? []).join('\n'),
    warmupMode: d.warmupMode ?? 'manual',
    updateFrequency: d.updateFrequency ?? '',
    updateTimesOfDay: d.updateTimesOfDay && d.updateTimesOfDay.length > 0 ? d.updateTimesOfDay : ['08:00'],
    updateDayOfWeek: String(d.updateDayOfWeek ?? 1),
    updateDayOfMonth: String(d.updateDayOfMonth ?? 1),
  };
}

function BiScheduleField({ times, onChange }: { times: string[]; onChange: (times: string[]) => void }) {
  const [newTime, setNewTime] = useState('');

  function addTime() {
    if (!newTime || times.includes(newTime)) return;
    onChange([...times].sort().concat(newTime).sort());
    setNewTime('');
  }

  function removeTime(t: string) {
    onChange(times.filter((x) => x !== t));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="time"
          value={newTime}
          onChange={(e) => setNewTime(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTime()}
          className="flex h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:focus:ring-sky-900/35"
        />
        <Button type="button" variant="outline" size="sm" onClick={addTime} disabled={!newTime}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Adicionar
        </Button>
      </div>
      {times.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {times.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-[#1b1b20] dark:text-zinc-300"
            >
              <Clock className="h-3 w-3 text-slate-400 dark:text-zinc-500" />
              {t}
              <button
                type="button"
                onClick={() => removeTime(t)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-slate-200 dark:hover:bg-[#27272a]"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
