import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ExecutionStatus } from '@prisma/client';
import { rm } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { executionRoot } from '../shared/storage';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 100;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private isSweeping = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Primeiro sweep 1min após o boot para não competir com a inicialização
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    setTimeout(() => void this.sweep(), 60 * 1000).unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async sweep() {
    if (this.isSweeping) {
      return;
    }

    this.isSweeping = true;
    try {
      await this.purgeExpiredSessions();
      await this.cleanOldExecutions();
      await this.purgeOldSiteChatMessages();
    } catch (error) {
      this.logger.error('Retention sweep failed', error);
    } finally {
      this.isSweeping = false;
    }
  }

  private async purgeExpiredSessions() {
    const { count } = await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) {
      this.logger.log(`Sessões expiradas removidas: ${count}`);
    }
  }

  // O chat de IA mantém uma única conversa contínua por usuário, sem telas
  // de histórico/múltiplas conversas — por design ela "expira" sozinha em
  // 24h (SiteChatService já não lê mensagens mais velhas que isso pro
  // contexto), então aqui só limpa o que já ficou inútil pra não crescer a
  // tabela pra sempre.
  private async purgeOldSiteChatMessages() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.siteChatMessage.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Mensagens de chat expiradas removidas: ${count}`);
    }
  }

  private async cleanOldExecutions() {
    const daysWithout = getRetentionDays('EXECUTION_RETENTION_DAYS', 30);
    const daysWith = getRetentionDays('EXECUTION_RETENTION_DAYS_WITH_OUTPUT', 90);

    await this.cleanBatch(daysWithout, false);
    await this.cleanBatch(daysWith, true);
  }

  private async cleanBatch(retentionDays: number, hasOutput: boolean) {
    if (retentionDays <= 0) return;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const label = hasOutput ? 'com retorno' : 'sem retorno';

    while (true) {
      const executions = await this.prisma.execution.findMany({
        where: {
          cleanedAt: null,
          finishedAt: { lt: cutoff },
          status: { in: [ExecutionStatus.success, ExecutionStatus.error, ExecutionStatus.canceled] },
          files: hasOutput ? { some: { kind: 'output' } } : { none: { kind: 'output' } },
        },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (executions.length === 0) return;

      for (const execution of executions) {
        await rm(executionRoot(execution.id), { recursive: true, force: true });
        await this.prisma.$transaction([
          this.prisma.executionLog.deleteMany({ where: { executionId: execution.id } }),
          this.prisma.executionFile.deleteMany({ where: { executionId: execution.id } }),
          this.prisma.execution.update({
            where: { id: execution.id },
            data: { cleanedAt: new Date() },
          }),
        ]);
      }

      this.logger.log(
        `Retenção (${label}): ${executions.length} execução(ões) com mais de ${retentionDays} dia(s) limpas.`,
      );
    }
  }
}

function getRetentionDays(key: string, fallback: number) {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  const raw = Number(val);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}
