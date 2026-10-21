import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Robot, type User } from '@prisma/client';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { execSync, spawn } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import { createExtractorFromData } from 'node-unrar-js';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildExecutionScope,
  canAccessExecution,
  canAccessRobot,
  normalizeDepartments,
} from '../shared/access';
import { generateToken, hashToken } from '../shared/crypto';
import { withoutParameters } from '../shared/execution-parameters';
import { WINDOWS_HIDE } from '../shared/process-options';
import { toUserFileName, uniqueStoredFileName } from '../shared/files';
import {
  ensureRobotExampleDirs,
  ensureRobotPipDir,
  ensureRobotScriptsDirs,
  executionRoot,
  robotExamplesDir,
  robotPipDir,
  robotRoot,
  robotScriptsDir,
  scheduleRoot,
} from '../shared/storage';

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

type PipStatus = 'installing' | 'done' | 'error';

@Injectable()
export class RobotsService {
  private readonly pipStatus = new Map<string, PipStatus>();

  constructor(private readonly prisma: PrismaService) {}

  getPipStatus(robotId: string): PipStatus | null {
    return this.pipStatus.get(robotId) ?? null;
  }

  async getHubOverview(user: User) {
    const executionScope = buildExecutionScope(user);

    const [
      robots,
      executions,
      runningExecutions,
      successfulExecutions,
      favoriteRows,
    ] = await Promise.all([
      this.prisma.robot.findMany({
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
        include: {
          inputExamples: {
            orderBy: { createdAt: 'desc' },
          },
          executions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            // Somente campos operacionais: a linha completa vazaria inputJson
            // (parâmetros de outros usuários), notes e errorMessage
            select: {
              id: true,
              status: true,
              progress: true,
              currentStep: true,
              createdAt: true,
              startedAt: true,
              finishedAt: true,
            },
          },
        },
      }),
      this.prisma.execution.findMany({
        where: executionScope,
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          robot: true,
          files: true,
          user: {
            select: {
              id: true,
              departments: true,
            },
          },
        },
      }),
      this.prisma.execution.count({
        where: { ...(executionScope ?? {}), status: 'running' },
      }),
      this.prisma.execution.count({
        where: { ...(executionScope ?? {}), status: 'success' },
      }),
      this.prisma.robotFavorite.findMany({
        where: { userId: user.id },
        select: { robotId: true },
      }),
    ]);
    const favoriteRobotIds = new Set(favoriteRows.map((item) => item.robotId));

    const visibleRobots = robots.filter((robot) => canAccessRobot(user, robot));
    const visibleRobotIds = new Set(visibleRobots.map((robot) => robot.id));
    const visibleExecutions = executions.filter(
      (execution) =>
        visibleRobotIds.has(execution.robotId) && canAccessExecution(user, execution),
    );

    return {
      stats: {
        totalRobots: visibleRobots.length,
        readyRobots: visibleRobots.filter((robot) => robot.isActive).length,
        runningExecutions,
        successfulExecutions,
      },
      robots: visibleRobots.map((robot) => ({
        ...sanitizeRobot(robot),
        isFavorite: favoriteRobotIds.has(robot.id),
        inputExamples: robot.inputExamples.map((item) => ({
          ...item,
          downloadUrl: `/storage/${item.storagePath}`,
        })),
        lastExecution: robot.executions[0] ?? null,
        executions: undefined,
      })),
      // Sem os parâmetros digitados (empresa, CPF, senha...): a tela inicial não usa e eles não devem sair em lista.
      recentExecutions: visibleExecutions.map(withoutParameters),
    };
  }

  async findAll(user: User) {
    const [robots, favoriteRows] = await Promise.all([
      this.prisma.robot.findMany({
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
        include: {
          inputExamples: {
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      this.prisma.robotFavorite.findMany({
        where: { userId: user.id },
        select: { robotId: true },
      }),
    ]);
    const favoriteRobotIds = new Set(favoriteRows.map((item) => item.robotId));

    return robots
      .filter((robot) => canAccessRobot(user, robot))
      .map((robot) => ({
        ...sanitizeRobot(robot),
        isFavorite: favoriteRobotIds.has(robot.id),
        inputExamples: robot.inputExamples.map((item) => ({
          ...item,
          downloadUrl: `/storage/${item.storagePath}`,
        })),
      }));
  }

  async favoriteRobot(robotId: string, user: User) {
    await this.requireAccessibleRobot(robotId, user);
    await this.prisma.robotFavorite.upsert({
      where: {
        userId_robotId: {
          userId: user.id,
          robotId,
        },
      },
      create: {
        userId: user.id,
        robotId,
      },
      update: {},
    });

    return { robotId, isFavorite: true };
  }

  async unfavoriteRobot(robotId: string, user: User) {
    await this.requireAccessibleRobot(robotId, user);
    await this.prisma.robotFavorite.deleteMany({
      where: {
        userId: user.id,
        robotId,
      },
    });

    return { robotId, isFavorite: false };
  }

  private async requireAccessibleRobot(robotId: string, user: User) {
    const robot = await this.prisma.robot.findUnique({ where: { id: robotId } });
    if (!robot || !canAccessRobot(user, robot)) {
      throw new NotFoundException('Automação não encontrada.');
    }
    return robot;
  }

  async findOne(idOrSlug: string, user: User) {
    const robot = await this.prisma.robot.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        executions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            files: true,
            user: {
              select: {
                id: true,
                departments: true,
              },
            },
          },
        },
        inputExamples: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!robot || !canAccessRobot(user, robot)) {
      return null;
    }

    return {
      ...sanitizeRobot(robot),
      executions: robot.executions
        .filter((execution) => canAccessExecution(user, execution))
        .map((execution) => ({
          ...execution,
          files: execution.files.map((file) => ({
            ...file,
            downloadUrl: `/storage/${file.storagePath}`,
          })),
        })),
      inputExamples: robot.inputExamples.map((item) => ({
        ...item,
        downloadUrl: `/storage/${item.storagePath}`,
      })),
    };
  }

  async addInputExample(
    robotId: string,
    input: {
      fileInputName?: string;
      title?: string;
      description?: string;
    },
    file?: UploadedFile,
  ) {
    const robot = await this.prisma.robot.findUnique({
      where: { id: robotId },
      select: { id: true },
    });

    if (!robot) {
      throw new BadRequestException('Automação não encontrada.');
    }

    if (!file?.buffer) {
      throw new BadRequestException('Envie um arquivo de modelo.');
    }

    const originalName = file.originalname?.trim() || 'modelo';
    const storedName = uniqueStoredFileName(originalName);
    const safeOriginalName = toUserFileName(originalName) || storedName;

    await ensureRobotExampleDirs(robot.id);

    const relativeStoragePath = `robots/${robot.id}/examples/${storedName}`;
    const absoluteStoragePath = join(robotExamplesDir(robot.id), storedName);
    await writeFile(absoluteStoragePath, file.buffer);

    const created = await this.prisma.robotInputExample.create({
      data: {
        robotId: robot.id,
        fileInputName: input.fileInputName?.trim() || null,
        title: input.title?.trim() || null,
        description: input.description?.trim() || null,
        filename: storedName,
        storagePath: relativeStoragePath,
        downloadName: safeOriginalName,
        mimeType: file.mimetype || null,
        size: typeof file.size === 'number' ? file.size : null,
      },
    });

    return {
      ...created,
      downloadUrl: `/storage/${created.storagePath}`,
    };
  }

  async removeInputExample(robotId: string, exampleId: string) {
    const item = await this.prisma.robotInputExample.findFirst({
      where: {
        id: exampleId,
        robotId,
      },
    });

    if (!item) {
      throw new BadRequestException('Modelo de entrada não encontrado.');
    }

    await this.prisma.robotInputExample.delete({
      where: { id: item.id },
    });

    await rm(join(process.cwd(), 'storage', item.storagePath), {
      force: true,
    });

    return { success: true };
  }

  async saveRobot(input: RobotUpsertInput) {
    const name = input.name?.trim();
    const slug = normalizeSlug(input.slug || input.name || '');

    if (!name) {
      throw new BadRequestException('Nome da automação é obrigatório.');
    }

    if (!slug) {
      throw new BadRequestException('Slug da automação é obrigatório.');
    }

    const duplicate = await this.prisma.robot.findFirst({
      where: {
        slug,
        NOT: input.id ? { id: input.id } : undefined,
      },
    });

    if (duplicate) {
      throw new BadRequestException('Já existe uma automação com este slug.');
    }

    const payload: Prisma.RobotUncheckedCreateInput = {
      slug,
      name,
      summary: input.summary?.trim() || null,
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      icon: input.icon?.trim() || 'bot',
      isActive: input.isActive ?? true,
      version: input.version?.trim() || '1.0.0',
      // Number('abc') = NaN passaria direto e viraria erro 500 do Prisma
      estimatedMinutes: sanitizeInt(input.estimatedMinutes, { min: 0, max: 100_000 }),
      maxConcurrency: sanitizeInt(input.maxConcurrency, { min: 1, max: 20 }) ?? 1,
      manualSecondsPerUnit: sanitizeInt(input.manualSecondsPerUnit, { min: 0, max: 1_000_000 }) ?? 0,
      unitLabel: input.unitLabel?.trim() || 'item',
      unitMetricKey: normalizeMetricKey(input.unitMetricKey) || 'itens_processados',
      conflictKeys: normalizeConflictKeys(input.conflictKeys),
      zipOutput: input.zipOutput ?? false,
      isExternal: input.isExternal ?? false,
      command: input.command?.trim() || null,
      workingDirectory: input.workingDirectory?.trim() || null,
      allowedDepartments: normalizeDepartments(input.allowedDepartments),
      schema: (input.schema ?? { fields: [], fileInputs: [] }) as Prisma.InputJsonValue,
      documentationUrl: input.documentationUrl?.trim() || null,
      documentationLabel: input.documentationLabel?.trim() || null,
      supportLabel: input.supportLabel?.trim() || null,
      supportValue: input.supportValue?.trim() || null,
      dataPolicy: input.dataPolicy?.trim() || null,
    };

    if (input.id) {
      const existing = await this.prisma.robot.findUnique({
        where: { id: input.id },
        select: { id: true },
      });
      if (!existing) {
        throw new BadRequestException('Automação não encontrada.');
      }

      const updated = await this.prisma.robot.update({
        where: { id: input.id },
        data: payload,
      });
      return sanitizeRobot(updated);
    }

    const created = await this.prisma.robot.create({
      data: payload,
    });
    return sanitizeRobot(created);
  }

  async uploadScript(robotId: string, entryScript: string, file?: UploadedFile) {
    const robot = await this.prisma.robot.findUnique({
      where: { id: robotId },
      select: { id: true },
    });

    if (!robot) {
      throw new BadRequestException('Automação não encontrada.');
    }

    if (!file?.buffer) {
      throw new BadRequestException('Envie um arquivo .zip com os scripts da automação.');
    }

    const entry = entryScript?.trim();
    if (!entry) {
      throw new BadRequestException('Informe o nome do script de entrada (ex: main.py).');
    }

    const scriptsDir = robotScriptsDir(robot.id);
    await ensureRobotScriptsDirs(robot.id);

    // Clear previous scripts
    await rm(scriptsDir, { recursive: true, force: true });
    await ensureRobotScriptsDirs(robot.id);

    const originalName = (file.originalname ?? '').toLowerCase();

    if (originalName.endsWith('.rar')) {
      const arrayBuffer = file.buffer.buffer.slice(
        file.buffer.byteOffset,
        file.buffer.byteOffset + file.buffer.byteLength,
      ) as ArrayBuffer;
      const extractor = await createExtractorFromData({ data: arrayBuffer });
      const extracted = extractor.extract();
      const containmentRoot = resolve(scriptsDir) + sep;
      for (const entry of extracted.files) {
        if (entry.fileHeader.flags.directory) continue;
        if (!entry.extraction) continue;
        // Zip-slip: uma entrada "..\..\x" escreveria fora da pasta do robô
        const outPath = resolve(scriptsDir, entry.fileHeader.name);
        if (!outPath.startsWith(containmentRoot)) continue;
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, Buffer.from(entry.extraction));
      }
    } else {
      const zip = new AdmZip(file.buffer);
      zip.extractAllTo(scriptsDir, true);
    }

    const requirementsTxt = join(scriptsDir, 'requirements.txt');
    const hasRequirements = await access(requirementsTxt).then(() => true).catch(() => false);

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const command = `${pythonCmd} ${entry}`;
    const workingDirectory = scriptsDir;
    const scriptFileName = file.originalname ?? null;

    await writeFile(join(scriptsDir, '_upload.zip'), file.buffer);

    const updated = await this.prisma.robot.update({
      where: { id: robot.id },
      data: { command, workingDirectory, scriptFileName },
    });

    if (hasRequirements) {
      const content = await import('node:fs/promises').then((fs) =>
        fs.readFile(requirementsTxt, 'utf8').catch(() => ''),
      );
      const hasPackages = content
        .split('\n')
        .some((line) => line.trim() && !line.trim().startsWith('#'));

      const pipDir = robotPipDir(robot.id);
      await rm(pipDir, { recursive: true, force: true });

      if (hasPackages) {
        const venvPip = process.platform === 'win32'
          ? join(pipDir, 'Scripts', 'pip.exe')
          : join(pipDir, 'bin', 'pip');

        this.pipStatus.set(robot.id, 'installing');

        try {
          execSync(`${pythonCmd} -m venv --system-site-packages "${pipDir}"`, { stdio: 'inherit', windowsHide: WINDOWS_HIDE });
        } catch (err) {
          console.error(`[venv] erro ao criar venv: ${String(err)}`);
          this.pipStatus.set(robot.id, 'error');
          return sanitizeRobot(updated);
        }

        const pip = spawn(venvPip, ['install', '-r', requirementsTxt], {
          stdio: 'inherit',
          shell: false,
          windowsHide: WINDOWS_HIDE,
        });
        pip.on('error', (err) => {
          console.error(`[pip] erro ao instalar dependencias: ${err.message}`);
          this.pipStatus.set(robot.id, 'error');
        });
        pip.on('close', (code) => {
          console.log(`[pip] instalacao concluida com codigo ${code}`);
          this.pipStatus.set(robot.id, code === 0 ? 'done' : 'error');
        });
      } else {
        this.pipStatus.set(robot.id, 'done');
      }
    } else {
      this.pipStatus.set(robot.id, 'done');
    }

    return sanitizeRobot(updated);
  }

  async generateApiKey(robotId: string) {
    const robot = await this.prisma.robot.findUnique({ where: { id: robotId } });
    if (!robot) {
      throw new BadRequestException('Automação não encontrada.');
    }

    // Prefixo reconhecível (estilo GitHub/Stripe) — a chave só é exibida uma
    // vez aqui; o banco guarda só o hash, igual ao token de sessão
    const apiKey = generateToken('ahk');
    await this.prisma.robot.update({
      where: { id: robotId },
      data: { apiKeyHash: hashToken(apiKey) },
    });

    return { apiKey };
  }

  async revokeApiKey(robotId: string) {
    const robot = await this.prisma.robot.findUnique({ where: { id: robotId } });
    if (!robot) {
      throw new BadRequestException('Automação não encontrada.');
    }

    await this.prisma.robot.update({
      where: { id: robotId },
      data: { apiKeyHash: null },
    });

    return { success: true };
  }

  async deleteRobot(id: string) {
    const robot = await this.prisma.robot.findUnique({
      where: { id },
      include: {
        executions: {
          select: { id: true, status: true },
        },
        scheduledTasks: {
          select: { id: true },
        },
      },
    });

    if (!robot) {
      throw new BadRequestException('Automação não encontrada.');
    }

    const hasLiveExecution = robot.executions.some(
      (execution) =>
        execution.status === 'queued' || execution.status === 'running',
    );
    if (hasLiveExecution) {
      throw new ConflictException(
        'Não é possível excluir uma automação com execuções em andamento.',
      );
    }

    const executionIds = robot.executions.map((execution) => execution.id);
    const scheduledTaskIds = robot.scheduledTasks.map((task) => task.id);

    await this.prisma.$transaction(async (tx) => {
      if (executionIds.length > 0) {
        await tx.executionLog.deleteMany({
          where: { executionId: { in: executionIds } },
        });
        await tx.executionFile.deleteMany({
          where: { executionId: { in: executionIds } },
        });
        await tx.execution.deleteMany({
          where: { id: { in: executionIds } },
        });
      }

      // A FK de ScheduledTask é Restrict: sem isto o delete do robô falha
      if (scheduledTaskIds.length > 0) {
        await tx.scheduledTask.deleteMany({
          where: { id: { in: scheduledTaskIds } },
        });
      }

      await tx.robot.delete({
        where: { id },
      });
    });

    await Promise.all([
      ...executionIds.map((executionId) =>
        rm(executionRoot(executionId), { recursive: true, force: true }),
      ),
      ...scheduledTaskIds.map((taskId) =>
        rm(scheduleRoot(taskId), { recursive: true, force: true }),
      ),
    ]);

    await rm(robotRoot(id), { recursive: true, force: true });

    return { success: true };
  }
}

export type RobotUpsertInput = {
  id?: string;
  slug?: string;
  name?: string;
  summary?: string;
  description?: string;
  category?: string;
  icon?: string;
  isActive?: boolean;
  version?: string;
  estimatedMinutes?: number | null;
  maxConcurrency?: number | null;
  manualSecondsPerUnit?: number | null;
  unitLabel?: string;
  unitMetricKey?: string;
  conflictKeys?: string;
  zipOutput?: boolean;
  isExternal?: boolean;
  command?: string;
  workingDirectory?: string;
  allowedDepartments?: unknown;
  schema?: Record<string, unknown>;
  documentationUrl?: string;
  documentationLabel?: string;
  supportLabel?: string;
  supportValue?: string;
  dataPolicy?: string;
};

// A API key nunca deve trafegar de volta pro cliente — só o hash fica salvo,
// e nem o hash deveria vazar; expomos só um booleano "tem chave configurada"
function sanitizeRobot<T extends Robot>(robot: T) {
  const { apiKeyHash, ...rest } = robot;
  return { ...rest, hasApiKey: Boolean(apiKeyHash) };
}

function sanitizeInt(
  value: number | null | undefined,
  bounds: { min: number; max: number },
) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

function normalizeSlug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeConflictKeys(value?: string) {
  if (!value) {
    return null;
  }

  const tokens = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return tokens.length > 0 ? Array.from(new Set(tokens)).join(', ') : null;
}

function normalizeMetricKey(value?: string) {
  if (!value) {
    return null;
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
