import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type UserMatchMethod =
  | 'ATHENAS_LOGIN'
  | 'ATHENAS_EMAIL'
  | 'HISTORICAL_LINK';

@Injectable()
export class ExecutionIdentitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByLogin(
    value: string,
  ): Promise<{ user: User; method: UserMatchMethod } | null> {
    const login = normalizeExternalLogin(value);
    if (!login) return null;

    const byAthenasLogin = await this.prisma.user.findFirst({
      where: {
        athenasLogin: {
          equals: login,
          mode: 'insensitive',
        },
      },
    });
    if (byAthenasLogin) {
      return { user: byAthenasLogin, method: 'ATHENAS_LOGIN' };
    }

    const email = login.includes('@') ? login : `${login}@athenas.local`;
    const byEmail = await this.prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });
    if (byEmail) {
      return { user: byEmail, method: 'ATHENAS_EMAIL' };
    }

    // Um vínculo administrativo anterior funciona como alias persistente sem
    // transformar a chave da automação em permissão para criar contas.
    const historicalLinks = await this.prisma.execution.findMany({
      where: {
        userId: { not: null },
        robot: { isExternal: true },
        OR: externalIdentityConditions(login),
      },
      select: {
        user: true,
      },
      distinct: ['userId'],
      take: 2,
    });

    if (historicalLinks.length === 1 && historicalLinks[0].user) {
      return { user: historicalLinks[0].user, method: 'HISTORICAL_LINK' };
    }

    return null;
  }

  async reconcileUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    const aliases = userAliases(user);
    if (aliases.length === 0) return { linkedExecutions: 0 };

    const result = await this.prisma.execution.updateMany({
      where: {
        userId: null,
        robot: { isExternal: true },
        OR: aliases.flatMap(externalIdentityConditions),
      },
      data: { userId: user.id },
    });

    return { linkedExecutions: result.count };
  }

  async listUnlinkedIdentities() {
    const [executions, ignored] = await Promise.all([
      this.prisma.execution.findMany({
        where: {
          userId: null,
          robot: { isExternal: true },
          OR: [
            { requestedByName: { not: null } },
            { requestedByEmail: { not: null } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        select: {
          requestedByName: true,
          requestedByEmail: true,
          manualEstimatedSeconds: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      this.prisma.externalIdentity.findMany({
        where: { ignored: true },
        select: { login: true },
      }),
    ]);
    const ignoredLogins = new Set(ignored.map((identity) => identity.login));

    const grouped = new Map<
      string,
      {
        login: string;
        receivedName: string;
        executions: number;
        savedSeconds: number;
        firstSeenAt: Date;
        lastSeenAt: Date;
      }
    >();

    for (const execution of executions) {
      const login = normalizeExternalLogin(
        execution.requestedByEmail ?? execution.requestedByName ?? '',
      );
      if (!login || ignoredLogins.has(login)) continue;

      const occurredAt = execution.finishedAt ?? execution.createdAt;
      const receivedName = execution.requestedByName?.trim() || login;
      const current = grouped.get(login);
      if (!current) {
        grouped.set(login, {
          login,
          receivedName,
          executions: 1,
          savedSeconds: execution.manualEstimatedSeconds ?? 0,
          firstSeenAt: occurredAt,
          lastSeenAt: occurredAt,
        });
        continue;
      }

      current.executions += 1;
      current.savedSeconds += execution.manualEstimatedSeconds ?? 0;
      if (occurredAt < current.firstSeenAt) current.firstSeenAt = occurredAt;
      if (occurredAt > current.lastSeenAt) current.lastSeenAt = occurredAt;
      if (receivedName !== login) current.receivedName = receivedName;
    }

    return [...grouped.values()].sort(
      (left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime(),
    );
  }

  async ignoreIdentity(loginValue: string, name?: string) {
    const login = normalizeExternalLogin(loginValue);
    if (!login) {
      throw new BadRequestException('Informe o login da identidade.');
    }

    await this.prisma.externalIdentity.upsert({
      where: { login },
      create: { login, name: name?.trim() || login, ignored: true },
      update: { ignored: true },
    });

    return { login, ignored: true };
  }

  async unignoreIdentity(loginValue: string) {
    const login = normalizeExternalLogin(loginValue);
    if (!login) {
      throw new BadRequestException('Informe o login da identidade.');
    }

    await this.prisma.externalIdentity.updateMany({
      where: { login },
      data: { ignored: false },
    });

    return { login, ignored: false };
  }

  async listIgnoredIdentities() {
    return this.prisma.externalIdentity.findMany({
      where: { ignored: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async linkIdentity(loginValue: string, userId: string) {
    const login = normalizeExternalLogin(loginValue);
    if (!login || !userId.trim()) {
      throw new BadRequestException('Informe o login e o usuário de destino.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    const canonicalMatch = await this.findUserByLogin(login);
    if (canonicalMatch && canonicalMatch.user.id !== user.id) {
      throw new BadRequestException(
        `Este login já corresponde a ${canonicalMatch.user.name}.`,
      );
    }

    const conflictingLinks = await this.prisma.execution.findMany({
      where: {
        userId: { not: null },
        robot: { isExternal: true },
        OR: externalIdentityConditions(login),
      },
      select: { userId: true },
      distinct: ['userId'],
      take: 2,
    });
    if (
      conflictingLinks.some(
        (execution) => execution.userId && execution.userId !== user.id,
      )
    ) {
      throw new BadRequestException(
        'Este login já possui execuções vinculadas a outro usuário.',
      );
    }

    const result = await this.prisma.execution.updateMany({
      where: {
        userId: null,
        robot: { isExternal: true },
        OR: externalIdentityConditions(login),
      },
      data: { userId: user.id },
    });

    return {
      login,
      userId: user.id,
      userName: user.name,
      linkedExecutions: result.count,
    };
  }
}

export function normalizeExternalLogin(value: string) {
  return value.trim().toLocaleLowerCase('pt-BR');
}

function externalIdentityConditions(login: string) {
  return [
    { requestedByName: { equals: login, mode: 'insensitive' as const } },
    { requestedByEmail: { equals: login, mode: 'insensitive' as const } },
  ];
}

function userAliases(user: Pick<User, 'athenasLogin' | 'email'>) {
  const aliases = new Set<string>();
  if (user.athenasLogin) aliases.add(normalizeExternalLogin(user.athenasLogin));
  aliases.add(normalizeExternalLogin(user.email));

  const canonicalSuffix = '@athenas.local';
  const email = normalizeExternalLogin(user.email);
  if (email.endsWith(canonicalSuffix)) {
    aliases.add(email.slice(0, -canonicalSuffix.length));
  }

  return [...aliases].filter(Boolean);
}
