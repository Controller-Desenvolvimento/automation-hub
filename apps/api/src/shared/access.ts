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
// `allowedUserIds` é opcional nos tipos: consultas que escolhem campos e esquecem dele tratam como "sem pessoas".
type WithUserIds = { allowedUserIds?: string[] | null };
type MinimalRobot = Pick<Robot, 'allowedDepartments'> & WithUserIds;
type MinimalSite = Pick<Site, 'allowedDepartments' | 'minRole'> & WithUserIds;
type MinimalDashboard = Pick<Dashboard, 'allowedDepartments' | 'minRole'> & WithUserIds;
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

/**
 * Regra de público de BIs, painéis e automações: departamentos E pessoas, somados.
 * - nada marcado: todos;
 * - pessoas na lista passam sempre (e, nos BIs e painéis, também passam do "só gestor");
 * - os departamentos marcados liberam o departamento inteiro;
 * - só pessoas marcadas: só elas; só departamentos marcados: só eles.
 */
function matchesAudience(
  user: MinimalUser,
  audience: { allowedDepartments?: string[] | null; allowedUserIds?: string[] | null },
): boolean {
  const departments = audience.allowedDepartments ?? [];
  const userIds = audience.allowedUserIds ?? [];
  if (departments.length === 0 && userIds.length === 0) return true;
  if (userIds.includes(user.id)) return true;
  return departments.some((department) => user.departments.includes(department));
}

export function canAccessRobot(user: MinimalUser, robot: MinimalRobot) {
  if (isAdmin(user)) {
    return true;
  }

  return matchesAudience(user, robot);
}

export function canAccessSite(user: MinimalUser, site: MinimalSite) {
  if (isAdmin(user)) return true;

  // Quem foi liberado pelo nome passa mesmo que o BI seja "só gestores".
  if ((site.allowedUserIds ?? []).includes(user.id)) return true;

  if (site.minRole === UserRole.manager && !isManager(user)) return false;

  return matchesAudience(user, site);
}

export function canAccessDashboard(user: MinimalUser, dashboard: MinimalDashboard) {
  if (isAdmin(user)) return true;

  // Quem foi liberado pelo nome passa mesmo que o painel seja "só gestores".
  if ((dashboard.allowedUserIds ?? []).includes(user.id)) return true;

  if (dashboard.minRole === UserRole.manager && !isManager(user)) return false;

  return matchesAudience(user, dashboard);
}

/**
 * Ao liberar pessoas num BI, elas precisam enxergar também o painel vinculado (senão o chat do João
 * no BI cai no chat normal). Devolve as que ainda NÃO passam pela regra do painel; só essas entram na
 * lista dele. Painel aberto a todos não precisa de ninguém.
 */
export function usersMissingDashboardAccess<U extends MinimalUser>(users: U[], dashboard: MinimalDashboard): U[] {
  return users.filter((candidate) => !canAccessDashboard(candidate, dashboard));
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
