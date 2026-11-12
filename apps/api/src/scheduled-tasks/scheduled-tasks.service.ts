import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, RecipientScope, ScheduleFrequency, type ScheduledTask, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessRobot, isAdmin, isManager } from '../shared/access';
import { ExecutionsService } from '../executions/executions.service';
import { MailService } from '../mail/mail.service';
import { resolveHubBaseUrl } from '../mail/scheduled-execution-alert';
import { fixMulterFilename, listFilesRecursively, sanitizeFileName, uniqueStoredFileName } from '../shared/files';
import { ensureScheduleDirs, scheduleInputDir, scheduleRoot } from '../shared/storage';
import { computeNextRunAt, computeNextRunAtMultiple, parseTimeOfDay } from './schedule-utils';
import {
  checkConfigFromTask,
  hasTimeLimit,
  parseCheckFields,
  parseLimitField,
  RESTART_PRIORITY,
  type TaskCheckFields,
  type TaskLimitFields,
} from './schedule-checks';
import { dependencyFailureText, resolveCycle } from './schedule-dependency';

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
  // Verificação por tempo (T0/T1/T2, em minutos). undefined = não enviado (preserva); vazio/null = "sem verificação".
  verifyT0Minutes?: unknown;
  verifyT1Minutes?: unknown;
  verifyT2Minutes?: unknown;
  // Teto de tempo (só para "sem verificação") e dependência de outro agendamento. undefined = não enviado (preserva).
  maxRuntimeMinutes?: unknown;
  dependsOnTaskId?: unknown;
};

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

@Injectable()
export class ScheduledTasksService {
  private readonly logger = new Logger(ScheduledTasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executionsService: ExecutionsService,
    @Optional() private readonly mailService?: MailService,
  ) {}

  // Regras da dependência entre agendamentos (ver schedule-dependency.ts). Lança BadRequestException com a mensagem.
  private async validateDependencyRules(selfId: string | null, dependsOnId: string | null, finalChecks: TaskLimitFields) {
    if (dependsOnId) {
      if (selfId && dependsOnId === selfId) {
        throw new BadRequestException('Um agendamento não pode depender dele mesmo.');
      }
      const target = await this.prisma.scheduledTask.findUnique({
        where: { id: dependsOnId },
        select: {
          id: true, name: true, dependsOnTaskId: true,
          verifyT0Minutes: true, verifyT1Minutes: true, verifyT2Minutes: true, maxRuntimeMinutes: true,
        },
      });
      if (!target) throw new BadRequestException('O agendamento indicado em "Depende de" não existe.');
      // Sem limite de tempo, o agendamento de que se depende poderia travar e segurar este para sempre.
      if (!hasTimeLimit(target)) {
        throw new BadRequestException(
          `O agendamento "${target.name}" precisa ter verificação por tempo (T0/T1/T2) ou um teto de tempo para que outro dependa dele; sem isso ele poderia travar e segurar este para sempre.`,
        );
      }
      if (selfId) {
        let current = target.dependsOnTaskId;
        for (let depth = 0; current && depth < 20; depth++) {
          if (current === selfId) {
            throw new BadRequestException('Dependência circular: o agendamento indicado já depende (direta ou indiretamente) deste.');
          }
          current = (await this.prisma.scheduledTask.findUnique({ where: { id: current }, select: { dependsOnTaskId: true } }))?.dependsOnTaskId ?? null;
        }
      }
    }

    // Outros dependem deste: ele não pode ficar sem nenhum limite de tempo.
    if (selfId && !hasTimeLimit(finalChecks)) {
      const dependents = await this.prisma.scheduledTask.findMany({ where: { dependsOnTaskId: selfId }, select: { name: true }, take: 5 });
      if (dependents.length > 0) {
        throw new BadRequestException(
          `Este agendamento precisa manter verificação por tempo ou um teto de tempo porque outros dependem dele (${dependents.map((d) => d.name).join(', ')}). Remova antes a dependência deles.`,
        );
      }
    }
  }

  // No disparo de um agendamento que depende de outro: roda normal, fica retido esperando, ou é pulado.
  private async evaluateDependency(task: ScheduledTask): Promise<
    | { kind: 'none' }
    | { kind: 'hold'; cycleFirstId: string; dependencyName: string }
    | { kind: 'skip'; detail: string; dependencyName: string; dependencyRobot: string; dependencyExecutionId: string | null }
  > {
    if (!task.dependsOnTaskId) return { kind: 'none' };
    const dep = await this.prisma.scheduledTask.findUnique({ where: { id: task.dependsOnTaskId }, include: { robot: true } });
    // Desativado de propósito: a dependência é ignorada (apagado: o campo já foi limpo pelo banco).
    if (!dep || !dep.isActive) return { kind: 'none' };

    const cycleFirstId = await this.executionsService.findCycleExecutionId(dep.id, task.lastRunAt);
    if (!cycleFirstId) {
      // O outro agendamento não disparou neste ciclo. Se foi por erro ao iniciar, é falha dele; senão simplesmente não estava marcado.
      if (dep.lastError) {
        return { kind: 'skip', detail: `falhou ao iniciar (${dep.lastError})`, dependencyName: dep.name, dependencyRobot: dep.robot.name, dependencyExecutionId: null };
      }
      return { kind: 'none' };
    }
    const snaps = await this.executionsService.getCycleSnapshots(cycleFirstId);
    if (!snaps) return { kind: 'none' };

    const state = resolveCycle({
      first: snaps.first,
      restart: snaps.restart,
      now: new Date(),
      restartExpected: checkConfigFromTask(dep) !== null,
    });
    if (state.state === 'success') return { kind: 'none' };
    if (state.state === 'pending') return { kind: 'hold', cycleFirstId, dependencyName: dep.name };
    return {
      kind: 'skip',
      detail: state.detail,
      dependencyName: dep.name,
      dependencyRobot: dep.robot.name,
      dependencyExecutionId: snaps.restart?.id ?? snaps.first.id,
    };
  }

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

    // T0/T1/T2: só administrador altera. Campo não enviado (tela antiga em cache, por exemplo) preserva o que existe:
    // por isso só entra no payload quando foi enviado de verdade.
    const checkParsed = parseCheckFields(input);
    let checkData: Partial<TaskCheckFields> = {};
    if (isAdmin(user) && checkParsed.present) {
      if (!checkParsed.ok) throw new BadRequestException(checkParsed.message);
      checkData = checkParsed.value;
    }

    // Teto de tempo e dependência (também só administrador; ausente = preserva).
    const limitParsed = parseLimitField(input.maxRuntimeMinutes);
    let limitData: { maxRuntimeMinutes?: number | null } = {};
    if (isAdmin(user) && limitParsed.present) {
      if (!limitParsed.ok) throw new BadRequestException(limitParsed.message);
      limitData = { maxRuntimeMinutes: limitParsed.value };
    }
    let dependencyData: { dependsOnTaskId?: string | null } = {};
    if (isAdmin(user) && input.dependsOnTaskId !== undefined) {
      dependencyData = { dependsOnTaskId: typeof input.dependsOnTaskId === 'string' && input.dependsOnTaskId.trim() ? input.dependsOnTaskId.trim() : null };
    }

    // Como o agendamento ficará depois de salvar: valores novos quando enviados, senão os que já existem.
    const finalChecks: TaskLimitFields = {
      verifyT0Minutes: 'verifyT0Minutes' in checkData ? checkData.verifyT0Minutes ?? null : existing?.verifyT0Minutes ?? null,
      verifyT1Minutes: 'verifyT1Minutes' in checkData ? checkData.verifyT1Minutes ?? null : existing?.verifyT1Minutes ?? null,
      verifyT2Minutes: 'verifyT2Minutes' in checkData ? checkData.verifyT2Minutes ?? null : existing?.verifyT2Minutes ?? null,
      maxRuntimeMinutes: 'maxRuntimeMinutes' in limitData ? limitData.maxRuntimeMinutes ?? null : existing?.maxRuntimeMinutes ?? null,
    };
    // Com T0/T1/T2 o T2 já é o teto: não guarda um segundo limite que ficaria sem efeito.
    if (checkConfigFromTask(finalChecks) && finalChecks.maxRuntimeMinutes !== null) {
      limitData = { maxRuntimeMinutes: null };
      finalChecks.maxRuntimeMinutes = null;
    }
    const finalDependsOn = 'dependsOnTaskId' in dependencyData ? dependencyData.dependsOnTaskId ?? null : existing?.dependsOnTaskId ?? null;
    await this.validateDependencyRules(existing?.id ?? null, finalDependsOn, finalChecks);

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
      ...checkData,
      ...limitData,
      ...dependencyData,
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

      // Depende de outro agendamento? Roda normal, fica retido esperando o ciclo dele, ou é pulado (dados antigos não
      // adiantam). Se a avaliação falhar, segue como se não houvesse dependência: perder o horário seria pior.
      let dependency: Awaited<ReturnType<ScheduledTasksService['evaluateDependency']>> = { kind: 'none' };
      try {
        dependency = await this.evaluateDependency(task);
      } catch (error) {
        this.logger.error(`Dependência do agendamento ${task.id} não pôde ser avaliada: ${String(error)}`);
      }

      const execution = await this.executionsService.createExecution(
        task.robotId,
        {
          userId: task.userId,
          notes: task.notes ?? undefined,
          priority: 0,
          parameters: (task.parameters as Record<string, unknown>) ?? {},
          scheduledTaskId: task.id,
          waitingOnExecutionId: dependency.kind === 'hold' ? dependency.cycleFirstId : undefined,
        },
        templateFiles,
      );

      let lastError: string | null = null;
      if (dependency.kind === 'hold') {
        await this.executionsService.updateQueueReason(
          execution.id,
          `Aguardando o agendamento "${dependency.dependencyName}" terminar (retida até lá).`,
        );
        await this.executionsService.log(execution.id, 'info', `Retida: espera o agendamento "${dependency.dependencyName}" terminar com sucesso.`);
      } else if (dependency.kind === 'skip') {
        const what = dependencyFailureText(dependency.dependencyName, dependency.detail);
        await this.executionsService.cancelHeld(execution.id, `Pulada: ${what}`);
        await this.executionsService.log(execution.id, 'warn', `Pulada: ${what}`);
        lastError = `Pulada neste ciclo: ${what}`.slice(0, 500);
        void this.mailService
          ?.sendDependencySkippedAlert({
            dependentRobot: task.robot.name,
            dependentSchedule: task.name,
            dependencyRobot: dependency.dependencyRobot,
            dependencySchedule: dependency.dependencyName,
            detail: what,
            dependencyExecutionId: dependency.dependencyExecutionId,
            baseUrl: resolveHubBaseUrl(),
          })
          .catch((err: unknown) => this.logger.warn(`E-mail de agendamento pulado (${task.id}) falhou: ${String(err)}`));
      }

      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
          isActive:
            task.frequency === ScheduleFrequency.once ? false : task.isActive,
          lastError,
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

  // Reinício automático da verificação por tempo: refaz do começo a execução agendada `failedExecutionId`
  // (2ª e última tentativa), com os mesmos parâmetros e arquivos-modelo do disparo normal e prioridade na fila.
  // Devolve null se o agendamento não existe mais ou foi desativado (nada a reiniciar).
  async restartScheduledRun(taskId: string, failedExecutionId: string) {
    const task = await this.prisma.scheduledTask.findUnique({ where: { id: taskId } });
    if (!task || !task.isActive) return null;

    const templateFiles = await this.loadTemplateFiles(task.id);
    const execution = await this.executionsService.createExecution(
      task.robotId,
      {
        userId: task.userId,
        notes: task.notes ?? undefined,
        priority: RESTART_PRIORITY,
        parameters: (task.parameters as Record<string, unknown>) ?? {},
        scheduledTaskId: task.id,
        attempt: 2,
        restartOfId: failedExecutionId,
      },
      templateFiles,
    );

    await this.prisma.scheduledTask.update({
      where: { id: task.id },
      data: { lastRunAt: new Date(), lastExecutionId: execution.id },
    });
    return execution;
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
