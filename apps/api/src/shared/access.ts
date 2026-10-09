import {
  type Dashboard,
  type Execution,
  Prisma,
  type Robot,
  type Site,
  type User,
  UserRole,
} from '@prisma/client';

type MinimalUser = Pick<User, 'id' | 'role' | 'departments'>;
type MinimalRobot = Pick<Robot, 'allowedDepartments'>;
type MinimalSite = Pick<Site, 'allowedDepartments' | 'minRole'>;
type MinimalDashboard = Pick<Dashboard, 'allowedDepartments' | 'minRole' | 'allowedUserIds'>;
type MinimalExecution = Pick<Execution, 'userId' | 'scheduledTaskId'> & {
  user?: Pick<User, 'departments'> | null;
};

export function isAdmin(user: MinimalUser) {
  // Inovação tem acesso de admin em todo o sistema — é o time que constrói
  // e dá suporte aos robôs.
  return user.role === UserRole.admin || user.departments.includes('inovacao');
}

export function effectiveRole(user: MinimalUser): UserRole {
  return isAdmin(user) ? UserRole.admin : user.role;
}

export function isManager(user: MinimalUser) {
  return user.role === UserRole.manager;
}

export function canManageRobots(user: MinimalUser) {
  return isAdmin(user);
}

export function canAccessRobot(user: MinimalUser, robot: MinimalRobot) {
  if (isAdmin(user)) {
    return true;
  }

  if (!robot.allowedDepartments || robot.allowedDepartments.length === 0) {
    return true;
  }

  return robot.allowedDepartments.some((department) =>
    user.departments.includes(department),
  );
}

export function canAccessSite(user: MinimalUser, site: MinimalSite) {
  if (isAdmin(user)) return true;

  if (site.minRole === UserRole.manager && !isManager(user)) return false;

  if (site.allowedDepartments.length === 0) return true;

  return site.allowedDepartments.some((department) =>
    user.departments.includes(department),
  );
}

export function canAccessDashboard(user: MinimalUser, dashboard: MinimalDashboard) {
  if (isAdmin(user)) return true;

  // Lista de usuários específicos é um modo alternativo — quando preenchida,
  // hierarquia/departamento deixam de valer para esse painel.
  if (dashboard.allowedUserIds.length > 0) {
    return dashboard.allowedUserIds.includes(user.id);
  }

  if (dashboard.minRole === UserRole.manager && !isManager(user)) return false;

  if (dashboard.allowedDepartments.length === 0) return true;

  return dashboard.allowedDepartments.some((department) =>
    user.departments.includes(department),
  );
}

export function canAccessExecution(user: MinimalUser, execution: MinimalExecution) {
  if (isAdmin(user)) {
    return true;
  }

  // Execuções agendadas: acesso controlado pelo robô (canAccessRobot nos call sites).
  // O usuário que criou o agendamento pode ser um admin — não faz sentido restringir
  // pela propriedade da execução quando ela foi disparada automaticamente pelo scheduler.
  if (execution.scheduledTaskId) {
    return true;
  }

  if (isManager(user)) {
    return Boolean(
      execution.user?.departments?.some((department) =>
        user.departments.includes(department),
      ),
    );
  }

  return execution.userId === user.id;
}

// Escopo de visibilidade de execuções para queries Prisma (where):
// admin vê tudo, manager vê o(s) próprio(s) departamento(s), employee só as suas.
// Execuções agendadas (scheduledTaskId != null) são incluídas sempre — o filtro
// fino por robô acontece in-memory via canAccessRobot nos call sites.
export function buildExecutionScope(
  user: Pick<User, 'id' | 'role' | 'departments'>,
): Prisma.ExecutionWhereInput | undefined {
  if (isAdmin(user)) {
    return undefined;
  }

  const scheduled: Prisma.ExecutionWhereInput = { scheduledTaskId: { not: null } };

  if (isManager(user) && user.departments.length > 0) {
    return {
      OR: [
        { user: { departments: { hasSome: user.departments } } },
        scheduled,
      ],
    };
  }

  return {
    OR: [
      { userId: user.id },
      scheduled,
    ],
  };
}

export function normalizeDepartments(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      ),
    ),
  );
}
