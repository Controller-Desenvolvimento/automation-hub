import { Injectable } from '@nestjs/common';
import { AutomationRequestStatus, RecipientScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        supportTicket: { select: { id: true, number: true } },
        execution: {
          select: {
            id: true,
            status: true,
            robot: { select: { name: true } },
            files: {
              where: { kind: 'output' },
              select: {
                id: true,
                downloadName: true,
                storagePath: true,
                mimeType: true,
                size: true,
              },
            },
          },
        },
      },
    });

    return notifications.map((n) => ({
      ...n,
      execution: n.execution
        ? {
            ...n.execution,
            files: n.execution.files.map((f) => ({
              ...f,
              downloadUrl: `/storage/${f.storagePath}`,
            })),
          }
        : null,
    }));
  }

  async countUnread(userId: string) {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async createForAutomationRequest(params: {
    requesterUserId: string;
    requesterName: string;
    title: string;
    systemName?: string | null;
    kindLabel?: string;
    pageLabel?: string;
  }) {
    const requestLabel = params.kindLabel?.trim() || 'automação';
    const pageLabel = params.pageLabel?.trim() || 'Solicitar automação';

    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        id: { not: params.requesterUserId },
        OR: [{ role: 'admin' }, { departments: { hasSome: ['inovacao'] } }],
      },
      select: { id: true },
    });

    if (users.length === 0) {
      return;
    }

    const title = `Novo pedido de ${requestLabel}: ${params.title}`;
    const body = [
      `${params.requesterName} abriu um novo pedido de ${requestLabel}.`,
      params.systemName ? `Sistema: ${params.systemName}.` : null,
      `Abra "${pageLabel}" para ver os detalhes e atualizar a triagem.`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' ');

    await this.prisma.notification.createMany({
      data: users.map((user) => ({
        userId: user.id,
        type: 'automation_request_new',
        title,
        body,
      })),
    });
  }

  async createForAutomationRequestStatusChange(params: {
    requesterUserId: string;
    requesterName: string;
    title: string;
    status: AutomationRequestStatus;
  }) {
    const statusLabel = automationRequestStatusLabel(params.status);

    await this.prisma.notification.create({
      data: {
        userId: params.requesterUserId,
        type: 'automation_request_status',
        title: `Atualização no pedido: ${params.title}`,
        body: `${params.requesterName}, seu pedido foi movido para ${statusLabel}. Fique de olho nas notificações para acompanhar as próximas etapas.`,
      },
    });
  }

  async createForScheduledTaskExecution(
    executionId: string,
    scheduledTaskId: string,
    status: 'success' | 'error',
    robotName: string,
  ) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: scheduledTaskId },
    });

    if (!task) {
      return;
    }

    let userIds: string[] = [];

    if (task.recipientScope === RecipientScope.all) {
      const users = await this.prisma.user.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      userIds = users.map((u) => u.id);
    } else if (task.recipientScope === RecipientScope.departments) {
      const depts = task.recipientDepartments as string[];
      if (depts.length > 0) {
        const users = await this.prisma.user.findMany({
          where: { isActive: true, departments: { hasSome: depts } },
          select: { id: true },
        });
        userIds = users.map((u) => u.id);
      }
    } else {
      userIds = task.recipientUserIds;
    }

    if (userIds.length === 0) {
      return;
    }

    const isSuccess = status === 'success';
    const title = isSuccess
      ? `${robotName}: resultado disponível`
      : `${robotName}: falha na execução`;
    const body = isSuccess
      ? `Agendamento "${task.name}" concluído. Arquivos prontos para download.`
      : `Agendamento "${task.name}" falhou. Verifique os detalhes da execução.`;

    await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: isSuccess ? 'execution_result' : 'execution_error',
        title,
        body,
        executionId,
      })),
    });
  }
}
function automationRequestStatusLabel(status: AutomationRequestStatus) {
  switch (status) {
    case AutomationRequestStatus.pending:
      return 'Pendente';
    case AutomationRequestStatus.review:
      return 'Em análise';
    case AutomationRequestStatus.approved:
      return 'Aprovado';
    case AutomationRequestStatus.in_progress:
      return 'Em desenvolvimento';
    case AutomationRequestStatus.done:
      return 'Concluído';
    case AutomationRequestStatus.rejected:
      return 'Recusado';
    default:
      return 'Atualizado';
  }
}
