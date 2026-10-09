import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ExecutionIdentitiesService } from '../execution-identities/execution-identities.service';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveRole, isAdmin, normalizeDepartments } from '../shared/access';
import {
  departmentsForAthenasLogin,
  formatAthenasPersonName,
} from '../shared/athenas-identity';
import { hashPassword, hashToken } from '../shared/crypto';
import { isValidMascotSkin } from '../shared/mascot-skins';
import { AthenasService } from './athenas.service';

const SESSION_TTL_DAYS = 7;
const SSO_TTL_MS = 30_000;

@Injectable()
export class AuthService {
  private readonly ssoTokens = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly athenas: AthenasService,
    private readonly identities: ExecutionIdentitiesService,
  ) {}

  async register(input: {
    name?: string;
    email?: string;
    password?: string;
    departments?: unknown;
  }) {
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase();
    const password = input.password?.trim();
    const departments = normalizeDepartments(input.departments);

    if (!name || !email || !password) {
      throw new BadRequestException('Nome, email e senha são obrigatórios.');
    }

    if (password.length < 6) {
      throw new BadRequestException('A senha deve ter pelo menos 6 caracteres.');
    }

    if (departments.length === 0) {
      throw new BadRequestException('Selecione pelo menos um departamento.');
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new BadRequestException('Já existe uma conta com este email.');
    }

    const userCount = await this.prisma.user.count();
    const isBootstrap = userCount === 0;

    // Contas novas nascem inativas: sem aprovação, qualquer pessoa na rede
    // poderia se registrar escolhendo os próprios departamentos e ganhar
    // acesso a robôs restritos. O primeiro usuário é o bootstrap de admin.
    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashPassword(password),
        role: isBootstrap ? UserRole.admin : UserRole.employee,
        departments,
        isActive: isBootstrap,
      },
    });

    if (!isBootstrap) {
      return {
        pendingApproval: true as const,
        message: 'Conta criada. Aguarde um administrador aprovar seu acesso.',
      };
    }

    return this.createSession(user.id);
  }

  async login(input: { login?: string; email?: string; password?: string }) {
    const rawLogin = (input.login ?? input.email)?.trim();
    const password = input.password?.trim();

    if (!rawLogin || !password) {
      throw new BadRequestException('Usuário e senha são obrigatórios.');
    }

    // Athenas path: logins sem @ (ex: JOAO.SILVA) quando integração está ligada
    // Exceção: contas locais sem athenasLogin (ex: admins criados manualmente) usam auth local
    if (!rawLogin.includes('@') && this.athenas.isEnabled()) {
      const localOnly = await this.prisma.user.findFirst({
        where: { email: rawLogin.toLowerCase(), athenasLogin: null },
      });
      if (!localOnly) {
        const result = await this.athenas.authenticate(rawLogin, password);
        if (!result.ok) {
          throw new UnauthorizedException('Credenciais inválidas.');
        }

      const athenasLogin = rawLogin.toUpperCase();
      const departments = departmentsForAthenasLogin(athenasLogin);

      // Nome: usa NOME do Athenas; fallback para login capitalizado
      const name = result.nome
        ? formatAthenasPersonName(result.nome)
        : formatAthenasPersonName(athenasLogin.replace(/\./g, ' '));

      let user = await this.prisma.user.findUnique({ where: { athenasLogin } });

      if (!user) {
        const email = `${rawLogin.toLowerCase()}@athenas.local`;
        user = await this.prisma.user.create({
          data: {
            name,
            email,
            athenasLogin,
            passwordHash: hashPassword(randomBytes(32).toString('hex')),
            role: UserRole.employee,
            departments,
            isActive: true,
          },
        });
      } else {
        // Sincroniza nome e departamento a cada login (Athenas é a fonte de verdade)
        const updates: Record<string, unknown> = {};
        if (name && user.name !== name) updates.name = name;
        if (departments.length > 0 && JSON.stringify(user.departments) !== JSON.stringify(departments)) {
          updates.departments = departments;
        }
        if (Object.keys(updates).length > 0) {
          user = await this.prisma.user.update({ where: { id: user.id }, data: updates });
        }
      }

      if (!user.isActive) {
        throw new ForbiddenException('Sua conta aguarda aprovação de um administrador.');
      }

      await this.identities.reconcileUser(user.id);
      return this.createSession(user.id);
      } // end if (!localOnly) — cai aqui se for conta local sem athenasLogin
    }

    // Local path: contas com email (ex: admin@empresa.com) ou contas locais sem @
    const email = rawLogin.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Sempre roda o scrypt (com hash dummy se não existe) para não revelar
    // por tempo de resposta quais emails estão cadastrados.
    const passwordOk = verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordOk) {
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    if (!user.isActive) {
      throw new ForbiddenException('Sua conta aguarda aprovação de um administrador.');
    }

    await this.identities.reconcileUser(user.id);
    return this.createSession(user.id);
  }

  async logout(request: Request) {
    const token = extractBearerToken(request);
    if (!token) {
      return { success: true };
    }

    await this.prisma.session.deleteMany({
      where: { tokenHash: hashToken(token) },
    });

    return { success: true };
  }

  async requireUser(request: Request) {
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Sessão não encontrada.');
    }

    const session = await this.prisma.session.findFirst({
      where: {
        tokenHash: hashToken(token),
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!session || !session.user.isActive) {
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    }

    return session.user;
  }

  async updateMascotSkin(userId: string, skin: unknown) {
    if (!isValidMascotSkin(skin)) {
      throw new BadRequestException('Mascote inválido.');
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { mascotSkin: skin },
    });

    return sanitizeUser(user);
  }

  ensureAdmin(user: { id: string; role: UserRole; departments: string[] }) {
    if (!isAdmin(user)) {
      throw new ForbiddenException('Apenas administradores podem executar esta ação.');
    }
  }

  generateSsoToken(userId: string): string {
    const token = randomBytes(32).toString('hex');
    this.ssoTokens.set(token, { userId, expiresAt: Date.now() + SSO_TTL_MS });
    return token;
  }

  async verifySsoToken(token: string) {
    const entry = this.ssoTokens.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      this.ssoTokens.delete(token);
      return null;
    }
    this.ssoTokens.delete(token);
    const user = await this.prisma.user.findUnique({ where: { id: entry.userId } });
    if (!user || !user.isActive) return null;
    return { athenasLogin: user.athenasLogin, name: user.name, email: user.email };
  }

  private async createSession(userId: string) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);

    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
      },
      include: {
        user: true,
      },
    });

    return {
      token,
      user: sanitizeUser(session.user),
    };
  }
}

const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString('hex'));

function verifyPassword(password: string, storedHash: string) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) {
    return false;
  }

  const incomingHash = scryptSync(password, salt, 64);
  const existingHash = Buffer.from(hash, 'hex');

  return (
    incomingHash.length === existingHash.length &&
    timingSafeEqual(incomingHash, existingHash)
  );
}

function extractBearerToken(request: Request) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice('Bearer '.length).trim();
}

function sanitizeUser(user: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  departments: string[];
  mascotSkin: string;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: effectiveRole(user),
    departments: user.departments,
    mascotSkin: user.mascotSkin,
  };
}
