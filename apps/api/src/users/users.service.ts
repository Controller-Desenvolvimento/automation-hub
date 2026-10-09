import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ExecutionIdentitiesService } from '../execution-identities/execution-identities.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeDepartments } from '../shared/access';
import { hashPassword } from '../shared/crypto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: ExecutionIdentitiesService,
  ) {}

  async listUsers() {
    return this.prisma.user.findMany({
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        departments: true,
        isActive: true,
        createdAt: true,
        athenasLogin: true,
      },
    });
  }

  async createUser(input: {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    role?: unknown;
    departments?: unknown;
  }) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password.trim() : '';
    const role = parseRole(input.role) ?? UserRole.employee;
    const departments = normalizeDepartments(input.departments);

    if (!name || !email || !password) {
      throw new BadRequestException('Nome, email e senha são obrigatórios.');
    }

    if (password.length < 6) {
      throw new BadRequestException('A senha deve ter pelo menos 6 caracteres.');
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new BadRequestException('Já existe uma conta com este email.');
    }

    return this.prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashPassword(password),
        role,
        departments,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        departments: true,
        isActive: true,
        createdAt: true,
        athenasLogin: true,
      },
    });
  }

  async updateUser(
    id: string,
    input: {
      name?: unknown;
      password?: unknown;
      role?: unknown;
      departments?: unknown;
      isActive?: unknown;
    },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    const role = parseRole(input.role) ?? user.role;
    const departments =
      input.departments === undefined
        ? user.departments
        : normalizeDepartments(input.departments);
    const isActive =
      typeof input.isActive === 'boolean' ? input.isActive : user.isActive;

    // Não deixa rebaixar/desativar o último admin ativo — seria lockout
    // permanente do painel de administração
    const losesAdminAccess =
      user.role === UserRole.admin &&
      user.isActive &&
      (role !== UserRole.admin || !isActive);
    if (losesAdminAccess) {
      const activeAdmins = await this.prisma.user.count({
        where: { role: UserRole.admin, isActive: true },
      });
      if (activeAdmins <= 1) {
        throw new BadRequestException(
          'Este é o último administrador ativo. Promova outro usuário antes de rebaixá-lo ou desativá-lo.',
        );
      }
    }

    const data: {
      role: UserRole;
      departments: string[];
      isActive: boolean;
      name?: string;
      passwordHash?: string;
    } = { role, departments, isActive };

    // Nome e senha de contas Athenas vêm do login corporativo e são
    // resincronizados a cada login — editar aqui seria sobrescrito na hora.
    const isAthenasLinked = Boolean(user.athenasLogin);

    if (input.name !== undefined) {
      if (isAthenasLinked) {
        throw new BadRequestException(
          'Esse usuário é sincronizado pelo Athenas — o nome não pode ser alterado aqui.',
        );
      }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) {
        throw new BadRequestException('Nome não pode ficar em branco.');
      }
      data.name = name;
    }

    if (input.password !== undefined && input.password !== '') {
      if (isAthenasLinked) {
        throw new BadRequestException(
          'Esse usuário é sincronizado pelo Athenas — a senha não pode ser alterada aqui.',
        );
      }
      const password = typeof input.password === 'string' ? input.password.trim() : '';
      if (password.length < 6) {
        throw new BadRequestException('A senha deve ter pelo menos 6 caracteres.');
      }
      data.passwordHash = hashPassword(password);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        departments: true,
        isActive: true,
        createdAt: true,
        athenasLogin: true,
      },
    });

    await this.identities.reconcileUser(updatedUser.id);
    return updatedUser;
  }

  listUnlinkedIdentities() {
    return this.identities.listUnlinkedIdentities();
  }

  linkUnlinkedIdentity(input: { login?: unknown; userId?: unknown }) {
    const login = typeof input.login === 'string' ? input.login : '';
    const userId = typeof input.userId === 'string' ? input.userId : '';
    return this.identities.linkIdentity(login, userId);
  }

  ignoreUnlinkedIdentity(input: { login?: unknown; name?: unknown }) {
    const login = typeof input.login === 'string' ? input.login : '';
    const name = typeof input.name === 'string' ? input.name : undefined;
    return this.identities.ignoreIdentity(login, name);
  }

  listIgnoredIdentities() {
    return this.identities.listIgnoredIdentities();
  }

  unignoreIdentity(input: { login?: unknown }) {
    const login = typeof input.login === 'string' ? input.login : '';
    return this.identities.unignoreIdentity(login);
  }
}

function parseRole(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  return Object.values(UserRole).includes(value as UserRole)
    ? (value as UserRole)
    : null;
}
