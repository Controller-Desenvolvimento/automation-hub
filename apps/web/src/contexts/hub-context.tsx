import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { api } from '../lib/api';
import type { DepartmentConfig, Execution, HubOverview } from '../lib/types';
import { useAuth } from './auth-context';

type HubContextValue = {
  hub: HubOverview | null;
  hubError: boolean;
  executions: Execution[];
  departments: DepartmentConfig[];
  refreshDepartments: () => Promise<void>;
  toast: string | null;
  notify: (message: string) => void;
  clearToast: () => void;
  refreshHub: () => Promise<void>;
  unreadNotifications: number;
  refreshUnreadCount: () => Promise<void>;
  /** Novidades do Suporte (número ao lado do menu): chamados esperando a Inovação e respostas novas aos seus chamados. */
  supportUnread: number;
  refreshSupportUnread: () => Promise<void>;
  /** Pedidos de automação/dashboard ainda sem triagem (só administradores; selo do menu "Quadro"). */
  requestsPending: number;
  refreshRequestsPending: () => Promise<void>;
};

const HubContext = createContext<HubContextValue | null>(null);

export function HubProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const [hub, setHub] = useState<HubOverview | null>(null);
  const [hubError, setHubError] = useState(false);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [departments, setDepartments] = useState<DepartmentConfig[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [supportUnread, setSupportUnread] = useState(0);
  const [requestsPending, setRequestsPending] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await api<{ count: number }>('/notifications/unread-count');
      setUnreadNotifications(data.count);
    } catch {
      // silent
    }
  }, []);

  const refreshSupportUnread = useCallback(async () => {
    try {
      const data = await api<{ unread: number }>('/support/summary');
      setSupportUnread(data.unread);
    } catch {
      // silent
    }
  }, []);

  const canViewBoard = user?.role === 'admin' || user?.departments.includes('inovacao') === true;

  const refreshRequestsPending = useCallback(async () => {
    if (!canViewBoard) {
      setRequestsPending(0);
      return;
    }
    try {
      const data = await api<{ pending: number }>('/automation-requests/summary');
      setRequestsPending(data.pending);
    } catch {
      // silent
    }
  }, [canViewBoard]);

  useEffect(() => {
    // Só faz polling autenticado: na tela de login isso geraria 401 a cada 30s
    if (!user) {
      setUnreadNotifications(0);
      setSupportUnread(0);
      setRequestsPending(0);
      return;
    }

    const tick = () => {
      void refreshUnreadCount();
      void refreshSupportUnread();
      void refreshRequestsPending();
    };
    tick();
    pollRef.current = setInterval(tick, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshUnreadCount, refreshSupportUnread, refreshRequestsPending, user]);

  const refreshDepartments = useCallback(async () => {
    try {
      const data = await api<DepartmentConfig[]>('/departments');
      setDepartments(data);
    } catch {
      // silent — fallback to empty list
    }
  }, []);

  const refreshHub = useCallback(async () => {
    try {
      const [hubData, executionsData] = await Promise.all([
        api<HubOverview>('/robots/hub'),
        api<Execution[]>('/executions'),
      ]);
      setHub(hubData);
      setExecutions(executionsData);
      setHubError(false);
    } catch {
      setHubError(true);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshDepartments();
  }, [refreshDepartments, user]);

  const notify = useCallback((message: string) => setToast(message), []);
  const clearToast = useCallback(() => setToast(null), []);

  const value = useMemo(
    () => ({ hub, hubError, executions, departments, refreshDepartments, toast, notify, clearToast, refreshHub, unreadNotifications, refreshUnreadCount, supportUnread, refreshSupportUnread, requestsPending, refreshRequestsPending }),
    [clearToast, departments, executions, hub, hubError, notify, refreshDepartments, refreshHub, toast, unreadNotifications, refreshUnreadCount, supportUnread, refreshSupportUnread, requestsPending, refreshRequestsPending],
  );

  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function useHub() {
  const context = useContext(HubContext);
  if (!context) throw new Error('useHub must be used inside HubProvider');
  return context;
}
