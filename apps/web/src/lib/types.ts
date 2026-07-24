export type UserRole = 'admin' | 'manager' | 'employee';

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
};

export type ManagedUser = User & {
  isActive: boolean;
  createdAt: string;
};

export type UnlinkedExternalIdentity = {
  login: string;
  receivedName: string;
  executions: number;
  savedSeconds: number;
  firstSeenAt: string;
  lastSeenAt: string;
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

export type TimeSavingsReport = {
  totals: {
    executions: number;
    savedSeconds: number;
    manualEstimatedSeconds: number;
    unitsProcessed: number;
  };
  byRobot: Array<{
    robotId: string;
    robotName: string;
    executions: number;
    savedSeconds: number;
    manualEstimatedSeconds: number;
    unitsProcessed: number;
  }>;
  byUser: Array<{
    userId: string;
    userName: string;
    executions: number;
    savedSeconds: number;
    manualEstimatedSeconds: number;
    unitsProcessed: number;
  }>;
  byDepartment: Array<{
    department: string;
    executions: number;
    savedSeconds: number;
    manualEstimatedSeconds: number;
    unitsProcessed: number;
  }>;
  trend: Array<{
    day: string;
    savedSeconds: number;
    executions: number;
  }>;
  executions: Array<{
    id: string;
    createdAt: string;
    robotId: string;
    robotName: string;
    userId: string | null;
    userName: string;
    unitsProcessed: number;
    unitLabel: string;
    manualEstimatedSeconds: number;
    savedSeconds: number;
  }>;
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
