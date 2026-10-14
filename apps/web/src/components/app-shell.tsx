import {
  Bell,
  BarChart3,
  BookOpen,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Globe,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  MessageSquarePlus,
  PlayCircle,
  CalendarDays,
  Search,
  Settings,
  Sun,
  UserCircle,
} from 'lucide-react';
import { ControllerLogo } from './controller-logo';
import { DeployBanner } from './deploy-banner';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { useTheme } from '../contexts/theme-context';
import { ROLE_LABELS } from '../lib/constants';
import { cn, initialsFor, timeAgo } from '../lib/utils';
import { api } from '../lib/api';
import type { Notification, Site } from '../lib/types';
import { AppIcon } from './app-icon';
import { SiteChatWidget } from './site-chat-widget';
import { SiteFavicon } from './site-favicon';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Separator } from './ui/separator';

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { hub, unreadNotifications, refreshUnreadCount } = useHub();
  const [search, setSearch] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<Notification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMobileNavOpen(false);
    setProfileOpen(false);
    setSearchOpen(false);
    setNotifOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!user) return;
    api<Site[]>('/sites').then(setSites).catch(() => {});
  }, [user]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const filteredRobots = useMemo(() => {
    if (!search.trim()) return [];
    const term = search.trim().toLowerCase();
    return (hub?.robots ?? [])
      .filter(
        (r) =>
          r.name.toLowerCase().includes(term) ||
          (r.summary ?? '').toLowerCase().includes(term) ||
          (r.category ?? '').toLowerCase().includes(term),
      )
      .slice(0, 5);
  }, [hub?.robots, search]);

  const filteredSites = useMemo(() => {
    if (!search.trim()) return [];
    const term = search.trim().toLowerCase();
    return sites
      .filter(
        (s) =>
          s.name.toLowerCase().includes(term) ||
          (s.description ?? '').toLowerCase().includes(term),
      )
  }, [sites, search]);
  const canViewBoard = user?.role === 'admin' || user?.departments.includes('inovacao') === true;

  const showDropdown = searchOpen && search.trim().length > 0;
  const hasResults = filteredRobots.length > 0 || filteredSites.length > 0;

  async function openNotifications() {
    if (notifOpen) { setNotifOpen(false); return; }
    setNotifOpen(true);
    setNotifLoading(true);
    try {
      const data = await api<Notification[]>('/notifications');
      setNotifItems(data);
      await refreshUnreadCount();
    } catch { /* silent */ } finally {
      setNotifLoading(false);
    }
  }

  async function markAllReadInPanel() {
    try {
      await api('/notifications/read-all', { method: 'PATCH' });
      setNotifItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
      await refreshUnreadCount();
    } catch { /* silent */ }
  }

  // Grupo sem título (label vazio) = item solto no topo, como o "Visão Geral" de outros apps.
  const navGroups = [
    {
      label: '',
      items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
    },
    {
      label: 'Automações',
      items: [
        { to: '/robots', label: 'Robôs', icon: PlayCircle },
        { to: '/sites', label: 'Sites', icon: Globe },
        { to: '/schedules', label: 'Agendamentos', icon: CalendarDays },
      ],
    },
    {
      label: 'Acompanhamento',
      items: [
        { to: '/history', label: 'Histórico', icon: History },
        { to: '/results', label: 'Resultados', icon: Download },
        { to: '/time-savings', label: 'Tempo ganho', icon: BarChart3 },
      ],
    },
    ...(canViewBoard
      ? [
          {
            label: 'Administração',
            items: [
              ...(user?.role === 'admin' ? [{ to: '/settings', label: 'Configurações', icon: Settings }, { to: '/docs', label: 'Dev Docs', icon: BookOpen }] : []),
              { to: '/admin/quadro', label: 'Quadro', icon: CheckCheck },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-[#09090b] dark:text-white">
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Fechar menu"
          />
          <aside className="relative h-full w-[280px] overflow-y-auto border-r border-slate-200 bg-white text-slate-900 shadow-xl dark:border-[#27272a] dark:bg-[#111113] dark:text-white">
            <div className="flex items-center px-5 py-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white dark:bg-[#1f1f23] dark:text-white">
                  <ControllerLogo className="h-7 w-7" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">Automation HUB</div>
                  <div className="truncate text-xs text-slate-500 dark:text-zinc-300">Controller</div>
                </div>
              </div>
            </div>
            <div className="px-5">
              <Separator className="dark:bg-white/10" />
            </div>
            <nav className="space-y-6 px-4 py-5">
              {navGroups.map((group, groupIndex) => (
                <div key={groupIndex} className="space-y-2">
                  {group.label ? (
                    <div className="px-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {group.label}
                    </div>
                  ) : null}
                  <div className="space-y-1">
                    {group.items.map(({ to, label, icon: Icon }) => (
                      <NavLink
                        key={to}
                        to={to}
                        end={to === '/'}
                        onClick={() => setMobileNavOpen(false)}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition',
                          isActive
                            ? 'bg-slate-100 text-slate-950 dark:bg-[#1b1b20] dark:text-white'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-zinc-300 dark:hover:bg-[#18181b] dark:hover:text-white',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className={cn('h-4 w-4 shrink-0', isActive && 'text-sky-500 dark:text-sky-400')} />
                          {label}
                        </>
                      )}
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
            </nav>

            <div className="px-4 pb-4">
              <div className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-500 dark:text-sky-400">
                Solicitação
              </div>
              <div className="space-y-2">
                <Link
                  to="/automation-requests"
                  onClick={() => setMobileNavOpen(false)}
                  className="flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-3 text-sm font-medium text-sky-800 transition hover:bg-sky-100 dark:border-sky-500/25 dark:bg-sky-950/20 dark:text-sky-100 dark:hover:bg-sky-950/35"
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-300" />
                  Solicitar automação
                </Link>
                <Link
                  to="/dashboard-requests"
                  onClick={() => setMobileNavOpen(false)}
                  className="flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-3 text-sm font-medium text-sky-800 transition hover:bg-sky-100 dark:border-sky-500/25 dark:bg-sky-950/20 dark:text-sky-100 dark:hover:bg-sky-950/35"
                >
                  <LayoutDashboard className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-300" />
                  Solicitar dashboard
                </Link>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-screen transition-[padding] duration-200',
          sidebarCollapsed ? 'lg:pl-[88px]' : 'lg:pl-[272px]',
        )}
      >
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-30 hidden overflow-x-hidden overflow-y-auto overscroll-y-contain border-r border-slate-200 bg-white text-slate-900 transition-[width] duration-200 dark:border-[#27272a] dark:bg-[#111113] dark:text-white lg:flex lg:flex-col',
            sidebarCollapsed ? 'w-[88px]' : 'w-[272px]',
          )}
        >
          <div
            className={cn(
              'flex items-center px-5 py-5',
              sidebarCollapsed ? 'justify-center' : 'justify-start',
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white dark:bg-[#1f1f23] dark:text-white">
                <ControllerLogo className="h-7 w-7" />
              </div>
              {!sidebarCollapsed ? (
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    Automation HUB
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-zinc-300">
                    Controller
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className={cn(sidebarCollapsed ? 'px-3' : 'px-5')}>
            <Separator className="dark:bg-white/10" />
          </div>

          <nav className={cn('flex-1 py-3', sidebarCollapsed ? 'space-y-3 px-3' : 'space-y-4 px-4')}>
            {navGroups.map((group, groupIndex) => (
              <div key={groupIndex} className="space-y-2">
                {sidebarCollapsed && groupIndex > 0 ? (
                  // Recolhida, os títulos somem: uma linha fina mantém os grupos distintos.
                  <div className="mx-2 mb-3 h-px bg-slate-200 dark:bg-white/10" />
                ) : null}
                {!sidebarCollapsed && group.label ? (
                  <div className="px-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {group.label}
                  </div>
                ) : null}

                <div className="space-y-1">
                  {group.items.map(({ to, label, icon: Icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={to === '/'}
                      aria-label={sidebarCollapsed ? label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'flex rounded-xl text-sm font-medium transition',
                          sidebarCollapsed
                            ? 'justify-center px-0 py-2.5'
                            : 'items-center gap-3 px-3 py-2.5',
                          isActive
                            ? 'bg-slate-100 text-slate-950 dark:bg-[#1b1b20] dark:text-white'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-zinc-300 dark:hover:bg-[#18181b] dark:hover:text-white',
                        )
                      }
                      title={sidebarCollapsed ? label : undefined}
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className={cn('h-4 w-4 shrink-0', isActive && 'text-sky-500 dark:text-sky-400')} />
                          {!sidebarCollapsed ? label : null}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className={cn('pb-4', sidebarCollapsed ? 'px-3' : 'px-4')}>
            {!sidebarCollapsed ? (
              <div className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-500 dark:text-sky-400">
                Solicitação
              </div>
            ) : null}
            <div className="space-y-2">
              <Link
                to="/automation-requests"
                title={sidebarCollapsed ? 'Solicitar automação' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 py-3 text-sm font-medium text-sky-800 transition hover:bg-sky-100 dark:border-sky-500/25 dark:bg-sky-950/20 dark:text-sky-100 dark:hover:bg-sky-950/35',
                  sidebarCollapsed ? 'justify-center px-0' : 'px-3',
                )}
              >
                <MessageSquarePlus className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-300" />
                {!sidebarCollapsed ? 'Solicitar automação' : null}
              </Link>
              <Link
                to="/dashboard-requests"
                title={sidebarCollapsed ? 'Solicitar dashboard' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 py-3 text-sm font-medium text-sky-800 transition hover:bg-sky-100 dark:border-sky-500/25 dark:bg-sky-950/20 dark:text-sky-100 dark:hover:bg-sky-950/35',
                  sidebarCollapsed ? 'justify-center px-0' : 'px-3',
                )}
              >
                <LayoutDashboard className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-300" />
                {!sidebarCollapsed ? 'Solicitar dashboard' : null}
              </Link>
            </div>
          </div>

        </aside>

        {/* Aba na borda da barra lateral: fica colada ao que controla e a seta mostra a direção.
            Fora do <aside> porque ele tem overflow e cortaria a metade que passa da borda. */}
        <button
          type="button"
          onClick={() => setSidebarCollapsed((current) => !current)}
          aria-label={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          title={sidebarCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          className={cn(
            'fixed top-[30px] z-40 hidden h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-600 shadow-md transition-[left,color,background-color,border-color] duration-200 hover:border-sky-400 hover:bg-sky-50 hover:text-sky-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-[#3a3a42] dark:bg-[#1b1b20] dark:text-zinc-300 dark:hover:border-sky-400 dark:hover:bg-[#232329] dark:hover:text-sky-300 lg:flex',
            sidebarCollapsed ? 'left-[74px]' : 'left-[258px]',
          )}
        >
          {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-[#27272a] dark:bg-[#09090b]/95">
            <div className="flex w-full items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
              <div className="flex w-full max-w-xl items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Alternar menu"
                  className="h-10 w-10 shrink-0 rounded-xl border border-slate-200 bg-white p-0 text-slate-700 hover:bg-slate-100 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b] dark:hover:text-white lg:hidden"
                  onClick={() => setMobileNavOpen((current) => !current)}
                >
                  <Menu className="h-4 w-4" />
                </Button>

                <div ref={searchRef} className="relative w-full">
                  <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    className="h-11 pl-10 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-100"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setSearchOpen(true); }}
                    onFocus={() => setSearchOpen(true)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }}
                    placeholder="Buscar robô ou site..."
                  />

                  {showDropdown ? (
                    <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-[#2b2b31] dark:bg-[#111113]">
                      {!hasResults ? (
                        <div className="px-4 py-6 text-center text-sm text-slate-400 dark:text-zinc-500">
                          Nenhum resultado para &ldquo;{search}&rdquo;
                        </div>
                      ) : (
                        <div className="py-1">
                          {filteredRobots.length > 0 ? (
                            <>
                              <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                                Automação
                              </div>
                              {filteredRobots.map((robot) => (
                                <button
                                  key={robot.id}
                                  type="button"
                                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-[#18181b]"
                                  onClick={() => { void navigate(`/robots/${robot.slug}`); setSearch(''); setSearchOpen(false); }}
                                >
                                  <AppIcon icon={robot.icon} className="h-8 w-8 shrink-0 rounded-xl" />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-slate-900 dark:text-white">{robot.name}</div>
                                    {robot.category ? (
                                      <div className="truncate text-xs text-slate-400 dark:text-zinc-500">{robot.category}</div>
                                    ) : null}
                                  </div>
                                </button>
                              ))}
                            </>
                          ) : null}

                          {filteredRobots.length > 0 && filteredSites.length > 0 ? (
                            <div className="mx-4 my-1 border-t border-slate-100 dark:border-white/[0.06]" />
                          ) : null}

                          {filteredSites.length > 0 ? (
                            <>
                              <div className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                                Site
                              </div>
                              {filteredSites.slice(0, 5).map((site) => (
                                <button
                                  key={site.id}
                                  type="button"
                                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-[#18181b]"
                                  onClick={() => { window.open(site.url, '_blank', 'noopener,noreferrer'); setSearch(''); setSearchOpen(false); }}
                                >
                                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
                                    <SiteFavicon siteId={site.id} className="h-5 w-5" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-slate-900 dark:text-white">{site.name}</div>
                                    {site.description ? (
                                      <div className="truncate text-xs text-slate-400 dark:text-zinc-500">{site.description}</div>
                                    ) : null}
                                  </div>
                                </button>
                              ))}
                              {filteredSites.length > 5 ? (
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-slate-500 transition hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-[#18181b]"
                                  onClick={() => {
                                    const biCount = filteredSites.filter((s) => s.category === 'bi').length;
                                    const sistemaCount = filteredSites.filter((s) => s.category === 'sistema').length;
                                    const tab = biCount > sistemaCount ? 'bi' : 'sistema';
                                    void navigate(`/sites?tab=${tab}&q=${encodeURIComponent(search.trim())}`);
                                    setSearch('');
                                    setSearchOpen(false);
                                  }}
                                >
                                  <Globe className="h-3.5 w-3.5 shrink-0" />
                                  Ver todos os {filteredSites.length} sites encontrados
                                </button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <div ref={notifRef} className="relative">
                  <button
                    type="button"
                    aria-label="Notificações"
                    className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white p-0 text-slate-700 transition hover:bg-slate-100 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b] dark:hover:text-white"
                    onClick={() => void openNotifications()}
                  >
                    <Bell className="h-4 w-4" />
                    {unreadNotifications > 0 ? (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-sky-500 text-[10px] font-bold text-white">
                        {unreadNotifications > 9 ? '9+' : unreadNotifications}
                      </span>
                    ) : null}
                  </button>

                  {notifOpen ? (
                    <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-96 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-[#27272a] dark:bg-[#111113]">
                      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-white/[0.06]">
                        <span className="text-sm font-semibold text-slate-900 dark:text-white">Notificações</span>
                        {notifItems.some((n) => !n.isRead) ? (
                          <button
                            type="button"
                            onClick={() => void markAllReadInPanel()}
                            className="flex items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                          >
                            <CheckCheck className="h-3.5 w-3.5" />
                            Marcar todas como lidas
                          </button>
                        ) : null}
                      </div>

                      <div className="max-h-[60vh] overflow-y-auto">
                        {notifLoading ? (
                          <div className="space-y-2 p-4">
                            {[1, 2, 3].map((i) => (
                              <div key={i} className="h-14 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60" />
                            ))}
                          </div>
                        ) : notifItems.length === 0 ? (
                          <div className="py-10 text-center">
                            <Bell className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-zinc-600" />
                            <p className="text-sm text-slate-500 dark:text-zinc-400">Nenhuma notificação ainda.</p>
                          </div>
                        ) : (
                          notifItems.slice(0, 10).map((n) => (
                            <NotifPanelItem
                              key={n.id}
                              notification={n}
                              onClose={() => setNotifOpen(false)}
                            />
                          ))
                        )}
                      </div>

                      <div className="border-t border-slate-100 p-2 dark:border-white/[0.06]">
                        <button
                          type="button"
                          onClick={() => { setNotifOpen(false); void navigate('/notifications'); }}
                          className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-200"
                        >
                          Ver todas as notificações
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
                  className="h-10 w-10 rounded-xl border border-slate-200 bg-white p-0 text-slate-700 hover:bg-slate-100 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-200 dark:hover:bg-[#18181b] dark:hover:text-white"
                  onClick={toggleTheme}
                >
                  {theme === 'dark' ? (
                    <Moon className="h-4 w-4" />
                  ) : (
                    <Sun className="h-4 w-4" />
                  )}
                </Button>

                <div className="relative">
                  <button
                    type="button"
                    aria-label="Perfil do usuário"
                    title={user?.name}
                    onClick={() => setProfileOpen((current) => !current)}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-200 bg-sky-50 text-xs font-semibold text-sky-700 transition hover:border-sky-300 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200 dark:hover:border-sky-500/50 dark:hover:bg-sky-500/20"
                  >
                    {initialsFor(user?.name ?? 'AH')}
                  </button>

                  {profileOpen ? (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setProfileOpen(false)}
                      />
                      <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-[#2b2b31] dark:bg-[#111113]">
                        <div className="border-b border-slate-100 px-4 py-3 dark:border-white/[0.06]">
                          <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                            {user?.name ?? 'Usuário'}
                          </div>
                          <div className="truncate text-xs text-slate-500 dark:text-zinc-400">
                            {ROLE_LABELS[user?.role ?? 'employee']}
                          </div>
                        </div>
                        <Link
                          to="/profile"
                          className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:text-zinc-200 dark:hover:bg-[#18181b]"
                        >
                          <UserCircle className="h-4 w-4" />
                          Meu perfil
                        </Link>
                        <div className="mx-4 border-t border-slate-100 dark:border-white/[0.06]" />
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                          onClick={async () => {
                            setProfileOpen(false);
                            await logout();
                          }}
                        >
                          <LogOut className="h-4 w-4" />
                          Sair
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </header>

          <DeployBanner />
          <main className="w-full px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>

      <SiteChatWidget />
    </div>
  );
}

function NotifPanelItem({
  notification,
  onClose,
}: {
  notification: Notification;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const isError = notification.type === 'execution_error';

  function handleClick() {
    onClose();
    if (notification.type === 'automation_request_new') {
      void navigate('/automation-requests');
      return;
    }
    if (notification.executionId) {
      void navigate(`/executions/${notification.executionId}`);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-white/[0.03]',
        !notification.isRead && 'bg-sky-50/50 dark:bg-sky-900/10',
      )}
    >
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', notification.isRead ? 'bg-transparent' : 'bg-sky-500')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-slate-900 dark:text-zinc-100">
            {notification.title}
          </span>
          <span className={cn(
            'shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium',
            isError
              ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
              : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
          )}>
            {isError ? 'Erro' : 'OK'}
          </span>
        </div>
        {notification.body ? (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{notification.body}</p>
        ) : null}
        <p className="mt-0.5 text-xs text-slate-400 dark:text-zinc-500">{timeAgo(notification.createdAt)}</p>
      </div>
    </button>
  );
}
