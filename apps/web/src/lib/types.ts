export type UserRole = 'admin' | 'manager' | 'employee';

export type DevDoc = {
  id: string;
  title: string;
  category: string;
  summary: string;
  howToUse: string;
  codeExample: string | null;
  language: string | null;
  endpoint: string | null;
  tags: string[];
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type Department = string;

export type DepartmentConfig = {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  order: number;
  createdAt: string;
};

export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  departments: Department[];
  mascotSkin: string;
};

export type ManagedUser = User & {
  isActive: boolean;
  createdAt: string;
  athenasLogin: string | null;
};

export type UnlinkedExternalIdentity = {
  login: string;
  receivedName: string;
  executions: number;
  savedSeconds: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type IgnoredIdentity = {
  login: string;
  name: string;
  department: string | null;
  ignored: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionResponse = {
  token: string;
  user: User;
};

export type RobotSchemaField = {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  defaultValue?: string;
  adminOnly?: boolean;
};

export type RobotSchemaFileInput = {
  name: string;
  label: string;
  accept?: string;
  multiple?: boolean;
  required?: boolean;
  helperText?: string;
};

export type RobotSchema = {
  fields: RobotSchemaField[];
  fileInputs: RobotSchemaFileInput[];
};

export type RobotInputExample = {
  id: string;
  robotId: string;
  fileInputName?: string | null;
  title?: string | null;
  description?: string | null;
  filename: string;
  storagePath: string;
  downloadName?: string | null;
  mimeType?: string | null;
  size?: number | null;
  createdAt: string;
  downloadUrl: string;
};

export type ExecutionFile = {
  id: string;
  kind: string;
  filename: string;
  originalName?: string | null;
  downloadName?: string | null;
  storagePath: string;
  downloadUrl: string;
  createdAt: string;
};

export type ExecutionLog = {
  id: string;
  level: string;
  message: string;
  timestamp: string;
};

export type Robot = {
  id: string;
  slug: string;
  name: string;
  summary?: string | null;
  description?: string | null;
  category?: string | null;
  icon?: string | null;
  isActive: boolean;
  version: string;
  estimatedMinutes?: number | null;
  maxConcurrency?: number | null;
  manualSecondsPerUnit?: number | null;
  unitLabel?: string | null;
  unitMetricKey?: string | null;
  conflictKeys?: string | null;
  zipOutput?: boolean;
  command?: string | null;
  workingDirectory?: string | null;
  isExternal?: boolean;
  isFavorite?: boolean;
  hasApiKey?: boolean;
  scriptFileName?: string | null;
  allowedDepartments: Department[];
  schema?: RobotSchema;
  documentationUrl?: string | null;
  documentationLabel?: string | null;
  supportLabel?: string | null;
  supportValue?: string | null;
  dataPolicy?: string | null;
  executions?: Execution[];
  inputExamples?: RobotInputExample[];
};

export type Execution = {
  id: string;
  robotId: string;
  robot: Robot;
  status: 'queued' | 'running' | 'success' | 'error' | 'canceled';
  progress: number;
  currentStep?: string | null;
  errorMessage?: string | null;
  unitsProcessed?: number | null;
  manualEstimatedSeconds?: number | null;
  requestedByName?: string | null;
  requestedByEmail?: string | null;
  scheduledTaskId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  files: ExecutionFile[];
  logs: ExecutionLog[];
};

export type RecipientScope = 'all' | 'departments' | 'specific';

export type ScheduledTask = {
  id: string;
  name: string;
  robotId: string;
  robot: Robot;
  userId: string;
  user: {
    id: string;
    name: string;
    email: string;
    departments: Department[];
  };
  frequency: 'once' | 'daily' | 'weekly' | 'monthly';
  timeOfDay: string;
  timesOfDay: string[];
  startDate?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timezone: string;
  notes?: string | null;
  parameters?: Record<string, unknown> | null;
  recipientScope: RecipientScope;
  recipientDepartments: Department[];
  recipientUserIds: string[];
  creditMode?: string;
  creditUserIds?: string[];
  creditDepartment?: string | null;
  isActive: boolean;
  lastRunAt?: string | null;
  nextRunAt: string;
  lastError?: string | null;
  lastExecutionId?: string | null;
  lastExecutionStatus?: 'queued' | 'running' | 'success' | 'error' | 'canceled' | null;
  createdAt: string;
  updatedAt: string;
  templateFiles?: string[];
  hasTemplateFiles?: boolean;
};

export type NotificationExecFile = {
  id: string;
  downloadName?: string | null;
  storagePath: string;
  downloadUrl: string;
  mimeType?: string | null;
  size?: number | null;
};

export type Notification = {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  executionId?: string | null;
  isRead: boolean;
  createdAt: string;
  execution?: {
    id: string;
    status: string;
    robot: { name: string };
    files: NotificationExecFile[];
  } | null;
};

export type HubOverview = {
  stats: {
    totalRobots: number;
    readyRobots: number;
    runningExecutions: number;
    successfulExecutions: number;
  };
  robots: Robot[];
  recentExecutions: Execution[];
};

export type TimeSavingsGranularity = 'day' | 'week' | 'month';
export type TimeSavingsOriginFilter = 'hub' | 'external';
// hub = robô rodado pelo hub; external = integração externa (tempo informado
// pelo próprio sistema); external_metric = métrica externa legada.
export type TimeSavingsOrigin = 'hub' | 'external' | 'external_metric';

export type TimeSavingsDelta = {
  previous: number;
  pct: number | null;
  direction: 'up' | 'down' | 'flat' | 'new';
};

export type TimeSavingsTotals = {
  // Execuções concluídas (status success), com ou sem ganho.
  executions: number;
  // Execuções com savedSeconds > 0.
  executionsWithSavings: number;
  executionsWithoutSavings: number;
  automationsWithSavings: number;
  // Pessoas distintas que receberam crédito por economia > 0.
  beneficiaries: number;
  savedSeconds: number;
  unitsProcessed: number;
  // Calculadas só sobre execuções com ganho.
  medianSavedSeconds: number | null;
  averageSavedSeconds: number | null;
  // savedSeconds ÷ (dias úteis do período × jornada). null sem dias úteis.
  capacityFte: number | null;
};

export type TimeSavingsConcentration = {
  count: number;
  top1Name: string | null;
  top1Pct: number;
  top3Pct: number;
};

export type TimeSavingsBucket = {
  key: string;
  label: string;
  from: string;
  to: string;
  savedSeconds: number;
  executions: number;
  previousSavedSeconds: number | null;
  previousExecutions: number | null;
  weekend: boolean;
};

export type TimeSavingsRunRate = {
  estimate: number;
  lowerBound: number;
  upperBound: number;
  sampleDays: number;
  activeDays: number;
  windowFrom: string;
  windowTo: string;
  blockDays: number;
  method: string;
};

export type TimeSavingsReport = {
  timezone: string;
  generatedAt: string;
  config: {
    workdayHours: number;
    outlierPercentile: number;
    runRateWindowDays: number;
    runRateMinSampleDays: number;
  };
  range: { from: string; to: string; days: number; businessDays: number } | null;
  // comparable = false quando o período anterior começa antes do primeiro dado
  // da base (não há como comparar um período cheio com um parcial).
  previousRange: { from: string; to: string; days: number; businessDays: number; comparable: boolean } | null;
  totals: TimeSavingsTotals;
  previousTotals: TimeSavingsTotals | null;
  deltas: {
    savedSeconds: TimeSavingsDelta | null;
    executionsWithSavings: TimeSavingsDelta | null;
    capacityFte: TimeSavingsDelta | null;
    beneficiaries: TimeSavingsDelta | null;
  } | null;
  concentration: {
    byRobot: TimeSavingsConcentration;
    byDepartment: TimeSavingsConcentration;
  };
  byRobot: Array<{
    robotId: string;
    robotName: string;
    executions: number;
    savedSeconds: number;
    sharePct: number;
  }>;
  byUser: Array<{
    userId: string;
    userName: string;
    executions: number;
    savedSeconds: number;
    sharePct: number;
  }>;
  byDepartment: Array<{
    department: string;
    executions: number;
    savedSeconds: number;
    sharePct: number;
  }>;
  granularity: TimeSavingsGranularity;
  autoGranularity: TimeSavingsGranularity;
  series: TimeSavingsBucket[];
  // Ritmo anual estimado: independente do período filtrado. null quando não há
  // amostra suficiente (ver runRateUnavailableReason).
  runRate: TimeSavingsRunRate | null;
  runRateUnavailableReason: 'no_data' | 'insufficient_sample' | null;
  outliers: {
    percentile: number;
    minSample: number;
    sampleSize: number;
    threshold: number | null;
    count: number;
    savedSeconds: number;
    sharePct: number;
    top: Array<{
      id: string;
      robotName: string;
      userName: string;
      savedSeconds: number;
      sharePct: number;
      at: string;
      origin: TimeSavingsOrigin;
    }>;
  };
  quality: {
    completedExecutions: number;
    executionsWithSavings: number;
    executionsWithoutSavings: number;
    automationsWithoutRate: {
      count: number;
      items: Array<{ robotId: string; robotName: string; executions: number }>;
    };
    missingUnits: { count: number; pct: number };
    assumedUnits: { count: number; savedSeconds: number; sharePct: number };
    byOrigin: Array<{
      origin: TimeSavingsOrigin;
      executions: number;
      executionsWithSavings: number;
      savedSeconds: number;
      sharePct: number;
    }>;
  };
};

export type TimeSavingsExecutionRow = {
  id: string;
  at: string;
  day: string;
  robotId: string;
  robotName: string;
  userId: string | null;
  userName: string;
  department: string;
  unitsProcessed: number;
  unitsMissing: boolean;
  unitsAssumed: boolean;
  unitLabel: string;
  savedSeconds: number;
  origin: TimeSavingsOrigin;
  isOutlier: boolean;
};

export type TimeSavingsExecutionsPage = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  savedSeconds: number;
  outlierThreshold: number | null;
  items: TimeSavingsExecutionRow[];
};

export type SiteStatus = 'online' | 'maintenance' | 'down';
export type SiteCategory = 'sistema' | 'bi';

export type PowerBIRefreshLog = {
  id: string;
  siteId: string;
  site: { id: string; name: string };
  requestedByName?: string | null;
  requestedByEmail?: string | null;
  status: string;
  requestedAt: string;
  completedAt?: string | null;
};

export type Site = {
  id: string;
  slug: string;
  name: string;
  url: string;
  description?: string | null;
  category: SiteCategory;
  status: SiteStatus;
  maintenanceOverride: boolean;
  hasFavicon: boolean;
  order: number;
  lastCheckedAt?: string | null;
  allowedDepartments: Department[];
  minRole: 'employee' | 'manager';
  powerbiGroupId?: string | null;
  powerbiDatasetId?: string | null;
  powerbiRefreshStatus?: string | null;
  powerbiLastRefreshAt?: string | null;
  powerbiScheduledTimes?: string[];
  powerbiShowRefresh?: boolean;
  ssoEnabled?: boolean;
  linkedDashboardId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SharedCredential = {
  id: string;
  name: string;
  url?: string | null;
  login: string;
  password: string;
  notes?: string | null;
  allowedDepartments: Department[];
  minRole: 'employee' | 'manager';
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRequestStatus = 'pending' | 'review' | 'approved' | 'in_progress' | 'done' | 'rejected';
export type AutomationRequestUrgency = 'low' | 'normal' | 'high' | 'urgent';
export type AutomationRequestCadence = 'once' | 'daily' | 'weekly' | 'monthly';

export type DashboardType = 'html' | 'streamlit' | 'server';

export type Dashboard = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  type: DashboardType;
  isActive: boolean;
  allowedDepartments: string[];
  minRole: UserRole;
  allowedUserIds: string[];
  mainFile: string;
  streamlitPort?: number | null;
  streamlitStatus?: string | null;
  streamlitRunning?: boolean | null;
  serverCommand?: string | null;
  serverWorkingDirectory?: string | null;
  updatePath?: string | null;
  warmupPaths?: string[];
  warmupMode: 'disabled' | 'manual' | 'auto';
  updateFrequency?: string | null;
  updateTimesOfDay?: string[];
  updateDayOfWeek?: number | null;
  updateDayOfMonth?: number | null;
  lastUpdateAt?: string | null;
  lastUpdateStatus?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRequest = {
  id: string;
  requesterUserId: string;
  requesterName: string;
  requesterEmail: string;
  title: string;
  systemName?: string | null;
  portalUrl?: string | null;
  description: string;
  urgency: AutomationRequestUrgency;
  cadence: AutomationRequestCadence;
  requiresLogin: boolean;
  requiresCertificate: boolean;
  requiresCaptcha: boolean;
  status: AutomationRequestStatus;
  adminNotes?: string | null;
  createdAt: string;
  updatedAt: string;
};
