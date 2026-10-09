import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, RecipientScope, ScheduleFrequency, type ScheduledTask, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessRobot, isAdmin, isManager } from '../shared/access';
import { ExecutionsService } from '../executions/executions.service';
import { fixMulterFilename, listFilesRecursively, sanitizeFileName, uniqueStoredFileName } from '../shared/files';
import { ensureScheduleDirs, scheduleInputDir, scheduleRoot } from '../shared/storage';
import { computeNextRunAt, computeNextRunAtMultiple, parseTimeOfDay } from './schedule-utils';

type SaveTaskInput = {
  id?: string;
  name?: string;
  robotId?: string;
  frequency?: string;
  timeOfDay?: string;
  timesOfDay?: string[];
  startDate?: string;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  notes?: string;
  parameters?: Record<string, unknown>;
  isActive?: boolean;
  recipientScope?: string;
  recipientDepartments?: string[];
  recipientUserIds?: string[];
  creditMode?: string;
  creditUserIds?: string[];
  creditDepartment?: string;
};

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

@Injectable()
export class ScheduledTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executionsService: ExecutionsService,
  ) {}

  async listTasks(user: User) {
    const tasks = await this.prisma.scheduledTask.findMany({
      where: buildTaskScope(user),
      orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        robot: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            departments: true,
          },
        },
      },
    });

    const visibleTasks = tasks.filter((task) => canAccessRobot(user, task.robot));
    const executionIds = Array.from(
      new Set(
        visibleTasks
          .map((task) => task.lastExecutionId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const executions =
      executionIds.length > 0
        ? await this.prisma.execution.findMany({
            where: { id: { in: executionIds } },
            select: { id: true, status: true },
          })
        : [];
    const executionStatusById = new Map(
      executions.map((execution) => [execution.id, execution.status]),
    );

    return Promise.all(
      visibleTasks.map(async (task) => {
        const templateFiles = await this.listTemplateFileNames(task.id);
        return {
          ...task,
          templateFiles,
          hasTemplateFiles: templateFiles.length > 0,
          lastExecutionStatus: task.lastExecutionId
            ? executionStatusById.get(task.lastExecutionId) ?? null
            : null,
        };
      }),
    );
  }

  async saveTask(user: User, input: SaveTaskInput, uploadedFiles: UploadedFile[]) {
    const name = input.name?.trim();
    const robotId = input.robotId?.trim();
    const frequency = parseFrequency(input.frequency);
    const startDate = parseStartDate(input.startDate);

    // Suporte a múltiplos horários: timesOfDay tem precedência sobre timeOfDay
    const rawTimes: string[] = Array.isArray(input.timesOfDay) && input.timesOfDay.length > 0
      ? input.timesOfDay.map((t) => t.trim()).filter(Boolean)
      : input.timeOfDay?.trim()
        ? [input.timeOfDay.trim()]
        : [];

    if (!name || !robotId || !frequency || rawTimes.length === 0) {
      throw new BadRequestException('Nome, robô, frequência e pelo menos um horário são obrigatórios.');
    }

    const validTimes = rawTimes.filter((t) => parseTimeOfDay(t) !== null);
    if (validTimes.length === 0) {
      throw new BadRequestException('Informe horários válidos no formato HH:mm.');
    }

    // Ordena os horários e usa o primeiro como timeOfDay (campo legado)
    validTimes.sort();
    const timeOfDay = validTimes[0];

    const existing = input.id
      ? await this.prisma.scheduledTask.findUnique({
          where: { id: input.id },
          include: {
            user: {
              select: {
                id: true,
                departments: true,
              },
            },
          },
        })
      : null;

    if (input.id && !existing) {
      throw new NotFoundException('Agendamento não encontrado.');
    }
    if (existing && !canManageTask(user, existing)) {
      throw new ForbiddenException('Você não pode editar este agendamento.');
    }

    // Só valida "data no futuro" quando a data/horário mudou: um agendamento
    // recorrente antigo tem startDate no passado e ficaria impossível de editar
    const existingTimes = existing ? (existing.timesOfDay.length > 0 ? existing.timesOfDay : [existing.timeOfDay]) : [];
    const dateChanged =
      !existing ||
      (startDate?.getTime() ?? null) !== (existing.startDate?.getTime() ?? null) ||
      JSON.stringify(validTimes) !== JSON.stringify(existingTimes.slice().sort());
    if (dateChanged) {
      validateScheduleDateAndTime(startDate, validTimes);
    }

    const robot = await this.prisma.robot.findUnique({ where: { id: robotId } });
    if (!robot || !canAccessRobot(user, robot)) {
      throw new NotFoundException('Automação não encontrada.');
    }

    const schema = (robot.schema ?? {}) as {
      fileInputs?: Array<{ required?: boolean }>;
    };
    const hasRequiredFiles = (schema.fileInputs ?? []).some((file) => file?.required);

    const nextRunAt = validTimes.length > 1
      ? computeNextRunAtMultiple({
          frequency,
          timesOfDay: validTimes,
          startDate,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
        })
      : computeNextRunAt({
          frequency,
          timeOfDay,
          startDate,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
        });

    const { recipientScope, recipientDepartments, recipientUserIds } =
      parseRecipients(user, input);

    const payload: Prisma.ScheduledTaskUncheckedCreateInput = {
      name,
      robotId,
      userId: user.id,
      frequency,
      timeOfDay,
      timesOfDay: validTimes,
      startDate,
      dayOfWeek:
        frequency === ScheduleFrequency.weekly ? normalizeWeekday(input.dayOfWeek) : null,
      dayOfMonth:
        frequency === ScheduleFrequency.monthly ? normalizeMonthDay(input.dayOfMonth) : null,
      notes: input.notes?.trim() || null,
      parameters: (input.parameters ?? {}) as Prisma.InputJsonValue,
      isActive: input.isActive ?? true,
      nextRunAt,
      timezone: 'America/Sao_Paulo',
      recipientScope,
      recipientDepartments,
      recipientUserIds,
      creditMode: ['creator', 'users', 'department'].includes(input.creditMode ?? '')
        ? input.creditMode!
        : 'creator',
      creditUserIds: input.creditUserIds ?? [],
      creditDepartment: input.creditDepartment?.trim() || null,
    };

    if (existing) {
      await this.persistTemplateFiles(existing.id, uploadedFiles);
      await this.ensureRequiredTemplates(existing.id, hasRequiredFiles);

      return this.prisma.scheduledTask.update({
        where: { id: existing.id },
        data: {
          ...payload,
          // Edição não transfere a propriedade para quem editou
          userId: existing.userId,
          // Editor não-admin não pode (nem sem querer) apagar os destinatários
          // configurados por um admin
          ...(isAdmin(user)
            ? {}
            : {
                recipientScope: existing.recipientScope,
                recipientDepartments: existing.recipientDepartments,
                recipientUserIds: existing.recipientUserIds,
                creditMode: existing.creditMode,
                creditUserIds: existing.creditUserIds,
                creditDepartment: existing.creditDepartment,
              }),
        },
        include: {
          robot: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              departments: true,
            },
          },
        },
      });
    }

    // Valida os arquivos obrigatórios ANTES de criar: validar depois deixava
    // um agendamento órfão ativo no banco quando o upload faltava
    if (hasRequiredFiles && !uploadedFiles.some((file) => file.buffer && file.buffer.length > 0)) {
      throw new BadRequestException(
        'Esta automação exige upload obrigatório. Envie os arquivos base no agendamento.',
      );
    }

    const created = await this.prisma.scheduledTask.create({
      data: payload,
      include: {
        robot: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            departments: true,
          },
        },
      },
    });

    await this.persistTemplateFiles(created.id, uploadedFiles);

    return created;
  }

  async deleteTask(user: User, id: string) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            departments: true,
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Agendamento não encontrado.');
    }
    if (!canManageTask(user, task)) {
      throw new ForbiddenException('Você não pode excluir este agendamento.');
    }

    await this.prisma.scheduledTask.delete({ where: { id } });
    await rm(scheduleRoot(id), { recursive: true, force: true });
    return { success: true };
  }

  async listDueTasks(now = new Date()) {
    return this.prisma.scheduledTask.findMany({
      where: {
        isActive: true,
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: 'asc' },
      include: {
        robot: true,
        user: true,
      },
      take: 20,
    });
  }

  async triggerTask(taskId: string) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: {
        robot: true,
        user: true,
      },
    });

    if (!task || !task.isActive) {
      return;
    }

    let nextRunAt: Date;
    if (task.frequency === ScheduleFrequency.once) {
      nextRunAt = task.nextRunAt;
    } else {
      const times = task.timesOfDay.length > 0 ? task.timesOfDay : [task.timeOfDay];
      try {
        const from = new Date(task.nextRunAt.getTime() + 1000);
        nextRunAt = times.length > 1
          ? computeNextRunAtMultiple({
              frequency: task.frequency,
              timesOfDay: times,
              startDate: task.startDate,
              dayOfWeek: task.dayOfWeek,
              dayOfMonth: task.dayOfMonth,
              from,
            })
          : computeNextRunAt({
              frequency: task.frequency,
              timeOfDay: times[0],
              startDate: task.startDate,
              dayOfWeek: task.dayOfWeek,
              dayOfMonth: task.dayOfMonth,
              from,
            });
      } catch {
        nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }
    }

    try {
      const templateFiles = await this.loadTemplateFiles(task.id);
      const execution = await this.executionsService.createExecution(
        task.robotId,
        {
          userId: task.userId,
          notes: task.notes ?? undefined,
          priority: 0,
          parameters: (task.parameters as Record<string, unknown>) ?? {},
          scheduledTaskId: task.id,
        },
        templateFiles,
      );

      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
          isActive:
            task.frequency === ScheduleFrequency.once ? false : task.isActive,
          lastError: null,
          lastExecutionId: execution.id,
        },
      });
    } catch (error) {
      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          isActive:
            task.frequency === ScheduleFrequency.once ? false : task.isActive,
          lastError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Falha ao disparar agendamento.',
          nextRunAt,
        },
      });
    }
  }

  private async persistTemplateFiles(taskId: string, uploadedFiles: UploadedFile[]) {
    if (uploadedFiles.length === 0) {
      return;
    }

    await rm(scheduleInputDir(taskId), { recursive: true, force: true });
    await ensureScheduleDirs(taskId);

    await Promise.all(
      uploadedFiles.map(async (file) => {
        if (!file.buffer) {
          return;
        }

        const storedName = uniqueStoredFileName(fixMulterFilename(file.originalname ?? 'arquivo'));
        const absolutePath = join(scheduleInputDir(taskId), storedName);
        await writeFile(absolutePath, file.buffer);
      }),
    );
  }

  private async ensureRequiredTemplates(taskId: string, hasRequiredFiles: boolean) {
    if (!hasRequiredFiles) {
      return;
    }

    const templateFiles = await this.listTemplateFileNames(taskId);
    if (templateFiles.length === 0) {
      throw new BadRequestException(
        'Esta automação exige upload obrigatório. Envie os arquivos base no agendamento.',
      );
    }
  }

  private async listTemplateFileNames(taskId: string) {
    try {
      const files = await listFilesRecursively(scheduleInputDir(taskId));
      return files
        .map((filePath) => sanitizeFileName(filePath.split(/[\\/]/).pop() ?? 'arquivo'))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async loadTemplateFiles(taskId: string): Promise<UploadedFile[]> {
    try {
      const files = await listFilesRecursively(scheduleInputDir(taskId));

      return Promise.all(
        files.map(async (filePath) => {
          const buffer = await readFile(filePath);
          return {
            originalname: sanitizeFileName(filePath.split(/[\\/]/).pop() ?? 'arquivo'),
            buffer,
            size: buffer.length,
          };
        }),
      );
    } catch {
      return [];
    }
  }
}

function parseFrequency(value?: string) {
  if (!value) {
    return null;
  }

  return Object.values(ScheduleFrequency).includes(value as ScheduleFrequency)
    ? (value as ScheduleFrequency)
    : null;
}

function normalizeWeekday(value?: number | null) {
  if (
    value === undefined ||
    value === null ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 6
  ) {
    throw new BadRequestException('Selecione um dia da semana válido.');
  }

  return Math.floor(value);
}

function normalizeMonthDay(value?: number | null) {
  if (
    value === undefined ||
    value === null ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > 31
  ) {
    throw new BadRequestException('Selecione um dia do mês entre 1 e 31.');
  }

  return Math.floor(value);
}

function buildTaskScope(user: User): Prisma.ScheduledTaskWhereInput | undefined {
  if (isAdmin(user)) {
    return undefined;
  }

  if (isManager(user)) {
    return {
      OR: [
        { userId: user.id },
        {
          user: {
            departments: {
              hasSome: user.departments,
            },
          },
        },
      ],
    };
  }

  return { userId: user.id };
}

function canManageTask(
  user: User,
  task: Pick<ScheduledTask, 'userId'> & {
    user?: { departments: string[] } | null;
  },
) {
  return isAdmin(user) || task.userId === user.id;
}

function parseStartDate(value?: string) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('Data do agendamento inválida.');
  }

  return parsed;
}

function parseRecipients(user: User, input: SaveTaskInput) {
  if (!isAdmin(user)) {
    // Ao menos o próprio criador recebe as notificações do resultado
    // (lista vazia = ninguém era notificado, silenciosamente)
    return {
      recipientScope: RecipientScope.specific,
      recipientDepartments: [] as string[],
      recipientUserIds: [user.id],
    };
  }

  const scope = Object.values(RecipientScope).includes(input.recipientScope as RecipientScope)
    ? (input.recipientScope as RecipientScope)
    : RecipientScope.specific;

  const recipientDepartments = (input.recipientDepartments ?? []).filter(
    (d): d is string => typeof d === 'string' && d.trim().length > 0,
  );

  const recipientUserIds = Array.isArray(input.recipientUserIds)
    ? input.recipientUserIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];

  return { recipientScope: scope, recipientDepartments, recipientUserIds };
}

function validateScheduleDateAndTime(startDate: Date | null, timesOfDay: string[]) {
  if (!startDate) {
    return;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (startDate < today) {
    throw new BadRequestException('Não é permitido agendar para datas anteriores.');
  }

  if (startDate.getTime() === today.getTime()) {
    const anyFuture = timesOfDay.some((t) => {
      const [hour, minute] = t.split(':').map(Number);
      const scheduled = new Date(now);
      scheduled.setHours(hour, minute, 0, 0);
      return scheduled > now;
    });
    if (!anyFuture) {
      throw new BadRequestException(
        'Para o dia atual, pelo menos um horário de disparo precisa ser futuro.',
      );
    }
  }
}
