import type { PrismaClient, User } from '@prisma/client';
import { canAccessExecution, canAccessRobot, isAdmin, isManager } from './access';

// Decide se o usuário pode baixar o caminho pedido em /storage/*.
// Autenticação por sessão não basta: outputs de execuções, templates de
// agendamento e scripts de robôs têm regras de acesso próprias.
export async function canAccessStoragePath(
  prisma: PrismaClient,
  user: User,
  rawPath: string,
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return false;
  }

  const segments = decoded.split('/').filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => segment === '..' || segment === '.')) {
    return false;
  }

  const [scope, id, sub] = segments;

  if (scope === 'executions') {
    const execution = await prisma.execution.findUnique({
      where: { id },
      select: {
        userId: true,
        scheduledTaskId: true,
        user: { select: { departments: true } },
        robot: { select: { allowedDepartments: true, allowedUserIds: true } },
      },
    });
    if (!execution) {
      return false;
    }

    return canAccessExecution(user, execution) && canAccessRobot(user, execution.robot);
  }

  if (scope === 'robots') {
    if (sub !== 'examples') {
      // scripts/ e pip/ são material de configuração — admin only
      return isAdmin(user);
    }

    const robot = await prisma.robot.findUnique({
      where: { id },
      select: { allowedDepartments: true, allowedUserIds: true },
    });

    return robot ? canAccessRobot(user, robot) : false;
  }

  if (scope === 'schedules') {
    if (isAdmin(user)) {
      return true;
    }

    const task = await prisma.scheduledTask.findUnique({
      where: { id },
      select: { userId: true, user: { select: { departments: true } } },
    });
    if (!task) {
      return false;
    }
    if (task.userId === user.id) {
      return true;
    }

    return (
      isManager(user) &&
      task.user.departments.some((department) => user.departments.includes(department))
    );
  }

  return false;
}
