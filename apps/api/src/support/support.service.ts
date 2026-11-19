import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessDashboard, canAccessExecution, canAccessRobot, isAdmin } from '../shared/access';
import { secretParameterNames } from '../shared/execution-parameters';
import { sanitizeFileName, fixMulterFilename, uniqueStoredFileName } from '../shared/files';
import { storageRoot, supportTicketDir } from '../shared/storage';
import {
  MAX_ATTACHMENTS,
  MAX_BODY,
  MAX_MERGE,
  MAX_TITLE,
  CLOSED_STATUSES,
  OPEN_STATUSES,
  STATUS_LABELS,
  TICKET_STATUSES,
  TICKET_SUBJECTS,
  TICKET_TYPES,
  TICKET_URGENCIES,
  URGENCY_LABELS,
  type TicketStatus,
  type TicketType,
  type TicketUrgency,
  checkAttachment,
  cleanText,
  computeKpis,
  isClosed,
  isOneOf,
  parseListQuery,
  suggestMergeGroups,
  toBool,
} from './support-rules';

export type SupportUpload = { originalname?: string; mimetype?: string; size?: number; path?: string };

type Actor = Pick<User, 'id' | 'name' | 'role' | 'departments'>;

const LINKED_NOTICE =
  'Seu chamado foi ligado a um problema que já estamos tratando. As respostas chegam aqui, no seu chamado.';

const TICKET_ROW_SELECT = {
  id: true,
  number: true,
  type: true,
  subject: true,
  urgency: true,
  status: true,
  title: true,
  hubArea: true,
  robotId: true,
  dashboardId: true,
  executionId: true,
  authorId: true,
  assigneeId: true,
  mainTicketId: true,
  needsAdmin: true,
  authorUnread: true,
  authorConfirmed: true,
  attachmentsCleanedAt: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  robot: { select: { id: true, name: true } },
  dashboard: { select: { id: true, name: true } },
  author: { select: { id: true, name: true, role: true, departments: true } },
  assignee: { select: { id: true, name: true } },
  _count: { select: { linkedTickets: true } },
} satisfies Prisma.SupportTicketSelect;

type TicketRow = Prisma.SupportTicketGetPayload<{ select: typeof TICKET_ROW_SELECT }>;

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------- consultas ----------

  /** Opções do formulário: robôs e painéis que a pessoa pode ver e, para administradores, quem pode ser responsável. */
  async options(user: User) {
    const [robots, dashboards, admins] = await Promise.all([
      this.prisma.robot.findMany({
        where: { isActive: true },
        select: { id: true, name: true, allowedDepartments: true, allowedUserIds: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.dashboard.findMany({
        where: { isActive: true },
        select: { id: true, name: true, allowedDepartments: true, allowedUserIds: true, minRole: true },
        orderBy: { name: 'asc' },
      }),
      isAdmin(user) ? this.listAdmins() : Promise.resolve([]),
    ]);
    return {
      robots: robots.filter((r) => canAccessRobot(user, r)).map((r) => ({ id: r.id, name: r.name })),
      dashboards: dashboards.filter((d) => canAccessDashboard(user, d)).map((d) => ({ id: d.id, name: d.name })),
      admins: admins.map((a) => ({ id: a.id, name: a.name })),
    };
  }

  /** Número do menu: o que ainda não foi visto. Administrador: chamados esperando a Inovação; todos: respostas novas aos próprios chamados. */
  async summary(user: User) {
    const [forAdmin, forAuthor] = await Promise.all([
      isAdmin(user) ? this.prisma.supportTicket.count({ where: { needsAdmin: true, mainTicketId: null } }) : 0,
      this.prisma.supportTicket.count({ where: { authorId: user.id, authorUnread: true } }),
    ]);
    return { unread: forAdmin + forAuthor, forAdmin, forAuthor };
  }

  /**
   * Lista paginada NO SERVIDOR (sem teto de chamados): filtros, ordem, página e contagens vêm do banco. Administradores levam
   * também os indicadores, as sugestões de juntar e as opções dos filtros.
   */
  async list(user: User, rawQuery: Record<string, unknown> = {}) {
    const admin = isAdmin(user);
    const query = parseListQuery(rawQuery);
    const base: Prisma.SupportTicketWhereInput = {
      ...(admin ? {} : { authorId: user.id }),
      ...(admin && query.tab === 'mine' ? { assigneeId: user.id } : {}),
      ...(query.urgency ? { urgency: query.urgency } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(admin && query.person ? { authorId: query.person } : {}),
      ...(admin && query.department ? { author: { departments: { has: query.department } } } : {}),
      ...(admin && query.robot ? { robotId: query.robot } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              ...(/^\d{1,9}$/.test(query.q) ? [{ number: Number(query.q) }] : []),
            ],
          }
        : {}),
    };
    const statusIn = (list: readonly TicketStatus[]) => ({ status: { in: [...list] } });
    const where: Prisma.SupportTicketWhereInput = {
      ...base,
      ...(query.situation === 'open' ? statusIn(OPEN_STATUSES) : query.situation === 'closed' ? statusIn(CLOSED_STATUSES) : {}),
    };
    const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] =
      query.sort === 'oldest'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : query.sort === 'urgency'
          ? [{ urgency: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }] // a ordem do enum no banco é crítica, alta, média, baixa
          : [{ updatedAt: 'desc' }, { id: 'asc' }];

    const [total, open, closed] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.count({ where: { ...base, ...statusIn(OPEN_STATUSES) } }),
      this.prisma.supportTicket.count({ where: { ...base, ...statusIn(CLOSED_STATUSES) } }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const tickets = await this.prisma.supportTicket.findMany({
      where,
      select: TICKET_ROW_SELECT,
      orderBy,
      skip: (page - 1) * query.pageSize,
      take: query.pageSize,
    });
    const result = {
      tickets: tickets.map((t) => this.toRow(t, admin)),
      page,
      pageSize: query.pageSize,
      total,
      totalPages,
      counts: { open, closed, all: open + closed },
    };
    if (!admin) {
      return result;
    }

    const [{ kpis, suggestions }, authors, robots] = await Promise.all([
      this.adminOverview(),
      this.prisma.user.findMany({ where: { supportTicketsAuthored: { some: {} } }, select: { id: true, name: true, departments: true }, orderBy: { name: 'asc' } }),
      this.prisma.robot.findMany({ where: { supportTickets: { some: {} } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return {
      ...result,
      kpis,
      suggestions,
      facets: {
        people: authors.map((a) => ({ id: a.id, name: a.name })),
        departments: [...new Set(authors.flatMap((a) => a.departments))].sort(),
        robots,
      },
    };
  }

  /** Indicadores e sugestões de juntar: olham os chamados em aberto e os dos últimos 30 dias (não a lista inteira). */
  private async adminOverview() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const tickets = await this.prisma.supportTicket.findMany({
      where: { OR: [{ status: { in: [...OPEN_STATUSES] } }, { createdAt: { gte: since } }] },
      select: {
        id: true, status: true, urgency: true, createdAt: true, robotId: true, mainTicketId: true, authorId: true,
        type: true, subject: true, dashboardId: true, hubArea: true, robot: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const replies = await this.prisma.supportMessage.findMany({
      where: { kind: 'message', ticketId: { in: tickets.map((t) => t.id) } },
      orderBy: { createdAt: 'asc' },
      select: { ticketId: true, authorId: true, createdAt: true },
    });
    const authorOf = new Map(tickets.map((t) => [t.id, t.authorId]));
    const firstReplyAt = new Map<string, Date>();
    for (const m of replies) {
      if (m.authorId && m.authorId !== authorOf.get(m.ticketId) && !firstReplyAt.has(m.ticketId)) {
        firstReplyAt.set(m.ticketId, m.createdAt);
      }
    }
    const kpis = computeKpis(
      tickets.map((t) => ({
        id: t.id, status: t.status, urgency: t.urgency, createdAt: t.createdAt,
        robotId: t.robotId, robotName: t.robot?.name ?? null, mainTicketId: t.mainTicketId,
      })),
      firstReplyAt,
    );
    const groups = suggestMergeGroups(
      tickets
        .filter((t) => OPEN_STATUSES.includes(t.status) && !t.mainTicketId) // quem já está ligado a outro não é sugerido de novo
        .map((t) => ({ id: t.id, type: t.type, subject: t.subject, robotId: t.robotId, dashboardId: t.dashboardId, hubArea: t.hubArea, createdAt: t.createdAt })),
    ).slice(0, 20);
    const ids = [...new Set(groups.flat())];
    const rows = ids.length ? await this.prisma.supportTicket.findMany({ where: { id: { in: ids } }, select: TICKET_ROW_SELECT }) : [];
    const byId = new Map(rows.map((r) => [r.id, this.toRow(r, true)]));
    const suggestions = groups.map((g) => g.map((id) => byId.get(id)!).filter(Boolean));
    return { kpis, suggestions };
  }

  /** Chamados parecidos com este (só administrador, só se está aberto e não ligado a outro). */
  private async similarTo(ticket: { id: string; type: TicketType; subject: string; robotId: string | null; dashboardId: string | null; hubArea: string | null; status: TicketStatus; mainTicketId: string | null }) {
    if (ticket.mainTicketId || !OPEN_STATUSES.includes(ticket.status) || ticket.subject === 'other') return [];
    const target = ticket.robotId
      ? { robotId: ticket.robotId }
      : ticket.dashboardId
        ? { dashboardId: ticket.dashboardId }
        : ticket.hubArea
          ? { hubArea: { equals: ticket.hubArea.trim(), mode: 'insensitive' as const } }
          : null;
    if (!target) return [];
    const candidates = await this.prisma.supportTicket.findMany({
      where: { status: { in: [...OPEN_STATUSES] }, mainTicketId: null, type: ticket.type, subject: ticket.subject as 'hub' | 'robot' | 'dashboard' | 'other', ...target },
      select: TICKET_ROW_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const group = suggestMergeGroups(
      candidates.map((t) => ({ id: t.id, type: t.type, subject: t.subject, robotId: t.robotId, dashboardId: t.dashboardId, hubArea: t.hubArea, createdAt: t.createdAt })),
    ).find((g) => g.includes(ticket.id));
    return group ? candidates.filter((t) => group.includes(t.id) && t.id !== ticket.id).map((t) => this.toRow(t, true)) : [];
  }

  async get(id: string, user: User) {
    const admin = isAdmin(user);
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: {
        ...TICKET_ROW_SELECT,
        contextJson: true,
        mainTicket: { select: { id: true, number: true, title: true } },
        linkedTickets: {
          select: { id: true, number: true, title: true, status: true, author: { select: { id: true, name: true, departments: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!ticket || (!admin && ticket.authorId !== user.id)) {
      throw new NotFoundException('Chamado não encontrado.');
    }

    const linkedAuthors = new Map(ticket.linkedTickets.map((l) => [l.id, l]));
    const messages = await this.prisma.supportMessage.findMany({
      where: {
        OR: [
          { ticketId: id },
          // O administrador vê, no principal, o que cada autor dos ligados escreveu (não as cópias das respostas da Inovação).
          ...(admin && ticket.linkedTickets.length > 0
            ? [{ ticketId: { in: ticket.linkedTickets.map((l) => l.id) }, kind: 'message' as const }]
            : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, name: true, role: true, departments: true } },
        attachments: true,
      },
    });

    const visible = messages.filter((m) => {
      if (m.ticketId === id) {
        return admin || (m.kind !== 'internal' && m.kind !== 'system_admin');
      }
      const link = linkedAuthors.get(m.ticketId);
      return !!link && m.authorId === link.author.id; // só o que o autor do ligado escreveu
    });

    // Quem abriu vê a novidade e a notificação some ao abrir o chamado.
    if (ticket.authorId === user.id && ticket.authorUnread) {
      await this.prisma.supportTicket.update({ where: { id }, data: { authorUnread: false }, select: { id: true } });
    }
    await this.prisma.notification.updateMany({
      where: { userId: user.id, supportTicketId: id, isRead: false },
      data: { isRead: true },
    });

    return {
      ...this.toRow({ ...ticket, authorUnread: ticket.authorId === user.id ? false : ticket.authorUnread }, admin),
      context: ticket.contextJson ?? null,
      similar: admin ? await this.similarTo(ticket) : [],
      main: admin ? ticket.mainTicket : null,
      linked: admin
        ? ticket.linkedTickets.map((l) => ({
            id: l.id,
            number: l.number,
            title: l.title,
            status: l.status,
            author: { id: l.author.id, name: l.author.name, departments: l.author.departments },
          }))
        : undefined,
      messages: visible.map((m) => {
        const link = m.ticketId === id ? null : linkedAuthors.get(m.ticketId);
        return {
          id: m.id,
          kind: m.kind,
          body: m.body,
          createdAt: m.createdAt,
          author: m.author ? { id: m.author.id, name: m.author.name, isStaff: isAdmin(m.author) } : null,
          fromTicket: link ? { id: link.id, number: link.number, authorName: link.author.name } : null,
          attachments: m.attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            mimeType: a.mimeType,
            size: a.size,
            isImage: a.isImage,
            removed: !!a.removedAt,
            downloadUrl: a.removedAt ? null : `/storage/${a.storagePath}`,
          })),
        };
      }),
    };
  }

  // ---------- abrir, responder ----------

  async create(user: User, body: Record<string, unknown>, files: SupportUpload[] = []) {
    try {
      const type = body.type;
      const subject = body.subject;
      if (!isOneOf(TICKET_TYPES, type)) throw new BadRequestException('Escolha o tipo do chamado.');
      if (!isOneOf(TICKET_SUBJECTS, subject)) throw new BadRequestException('Escolha o assunto do chamado.');
      const urgency = isOneOf(TICKET_URGENCIES, body.urgency) ? body.urgency : 'low';
      const title = cleanText(body.title, MAX_TITLE);
      const text = cleanText(body.body, MAX_BODY);
      if (title.length < 3) throw new BadRequestException('Dê um título ao chamado (pelo menos 3 letras).');
      if (!text) throw new BadRequestException('Descreva o que aconteceu.');
      const checked = this.checkUploads(files);

      let robotId: string | null = null;
      let dashboardId: string | null = null;
      let executionId: string | null = null;
      let hubArea: string | null = null;
      let contextJson: Prisma.InputJsonValue | undefined;

      if (subject === 'hub') {
        hubArea = cleanText(body.hubArea, 80) || null;
      }
      if (subject === 'robot' && typeof body.robotId === 'string' && body.robotId) {
        const robot = await this.prisma.robot.findUnique({
          where: { id: body.robotId },
          select: { id: true, allowedDepartments: true, allowedUserIds: true },
        });
        if (robot && canAccessRobot(user, robot)) robotId = robot.id;
      }
      if (subject === 'dashboard' && typeof body.dashboardId === 'string' && body.dashboardId) {
        const dashboard = await this.prisma.dashboard.findUnique({
          where: { id: body.dashboardId },
          select: { id: true, allowedDepartments: true, allowedUserIds: true, minRole: true },
        });
        if (dashboard && canAccessDashboard(user, dashboard)) dashboardId = dashboard.id;
      }
      if (typeof body.executionId === 'string' && body.executionId) {
        const snapshot = await this.snapshotExecution(user, body.executionId);
        if (snapshot) {
          executionId = snapshot.executionId;
          contextJson = snapshot.context as Prisma.InputJsonValue;
          robotId = robotId ?? snapshot.robotId;
        }
      }

      const ticket = await this.prisma.supportTicket.create({
        data: {
          type,
          subject,
          urgency,
          title,
          hubArea,
          robotId,
          dashboardId,
          executionId,
          contextJson,
          authorId: user.id,
          needsAdmin: true,
          messages: { create: { authorId: user.id, kind: 'message', body: text } },
        },
        select: { id: true, number: true, messages: { select: { id: true } } },
      });

      try {
        await this.storeAttachments(ticket.id, ticket.messages[0].id, checked);
      } catch (error) {
        await this.prisma.supportTicket.delete({ where: { id: ticket.id } }).catch(() => undefined);
        await rm(supportTicketDir(ticket.id), { recursive: true, force: true });
        throw error;
      }

      await this.notifyAdmins(user.id, ticket.id, 'support_new', `Novo chamado #${ticket.number}: ${title}`, `${user.name} abriu um chamado. Abra "Suporte" para ver os detalhes.`);
      return { id: ticket.id, number: ticket.number };
    } finally {
      await this.discardTemp(files);
    }
  }

  async addMessage(id: string, user: User, body: Record<string, unknown>, files: SupportUpload[] = []) {
    try {
      const admin = isAdmin(user);
      const ticket = await this.prisma.supportTicket.findUnique({
        where: { id },
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          authorId: true,
          assigneeId: true,
          mainTicketId: true,
          linkedTickets: { select: { id: true, number: true, authorId: true } },
        },
      });
      if (!ticket || (!admin && ticket.authorId !== user.id)) {
        throw new NotFoundException('Chamado não encontrado.');
      }

      const text = cleanText(body.body, MAX_BODY);
      const checked = this.checkUploads(files);
      if (!text && checked.length === 0) {
        throw new BadRequestException('Escreva uma mensagem ou anexe um arquivo.');
      }
      const internal = admin && toBool(body.internal);
      if (!admin && toBool(body.internal)) {
        throw new ForbiddenException('Só a Inovação escreve notas internas.');
      }
      const wantedStatus = admin && isOneOf(TICKET_STATUSES, body.status) ? body.status : null;
      const alsoLinked = admin && !internal && toBool(body.alsoLinked) && ticket.linkedTickets.length > 0;

      const message = await this.prisma.supportMessage.create({
        data: { ticketId: id, authorId: user.id, kind: internal ? 'internal' : 'message', body: text },
        select: { id: true },
      });
      const saved = await this.storeAttachments(id, message.id, checked);

      if (admin) {
        if (!internal) {
          const nextStatus = wantedStatus ?? (ticket.status === 'open' ? 'review' : ticket.status);
          await this.applyStatus(ticket.id, nextStatus, user, { silent: nextStatus === ticket.status, authorUnread: true, needsAdmin: false });
          if (alsoLinked) {
            for (const child of ticket.linkedTickets) {
              await this.copyReplyToLinked(child.id, user, text, saved);
            }
            await this.notifyUsers(
              ticket.linkedTickets.map((l) => l.authorId).filter((a) => a !== user.id),
              ticket.linkedTickets[0].id,
              'support_reply',
              `Chamado: nova resposta`,
              'A Inovação respondeu ao seu chamado.',
            );
          }
          if (ticket.authorId !== user.id) {
            await this.notifyUsers([ticket.authorId], ticket.id, 'support_reply', `Chamado #${ticket.number}: nova resposta`, `A Inovação respondeu ao chamado "${ticket.title}".`);
          }
        } else {
          await this.prisma.supportTicket.update({ where: { id }, data: { updatedAt: new Date() }, select: { id: true } });
        }
      } else {
        // Quem abriu respondeu: volta para a fila da Inovação (e, se estava encerrado, reabre).
        const reopen = isClosed(ticket.status);
        const nextStatus: TicketStatus = reopen ? 'open' : ticket.status === 'waiting' ? 'review' : ticket.status;
        await this.applyStatus(ticket.id, nextStatus, user, { silent: nextStatus === ticket.status, needsAdmin: true, authorUnread: false });
        if (ticket.mainTicketId) {
          await this.prisma.supportTicket.update({ where: { id: ticket.mainTicketId }, data: { needsAdmin: true, updatedAt: new Date() }, select: { id: true } });
        }
        await this.notifyStaffOfAuthorReply(user, ticket);
      }
      return { id: message.id };
    } finally {
      await this.discardTemp(files);
    }
  }

  // ---------- administração ----------

  async update(id: string, user: User, body: Record<string, unknown>) {
    this.requireAdmin(user);
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: { id: true, number: true, title: true, status: true, urgency: true, authorId: true, assigneeId: true },
    });
    if (!ticket) throw new NotFoundException('Chamado não encontrado.');

    if (body.urgency !== undefined) {
      if (!isOneOf(TICKET_URGENCIES, body.urgency)) throw new BadRequestException('Urgência inválida.');
      if (body.urgency !== ticket.urgency) {
        await this.prisma.$transaction([
          this.prisma.supportTicket.update({ where: { id }, data: { urgency: body.urgency }, select: { id: true } }),
          this.prisma.supportMessage.create({
            data: {
              ticketId: id,
              authorId: user.id,
              kind: 'system_admin',
              body: `Urgência alterada de ${URGENCY_LABELS[ticket.urgency]} para ${URGENCY_LABELS[body.urgency]} por ${user.name}.`,
            },
          }),
        ]);
      }
    }

    if (body.assigneeId !== undefined) {
      const wanted = body.assigneeId === null || body.assigneeId === '' ? null : String(body.assigneeId);
      if (wanted !== ticket.assigneeId) {
        let name = 'ninguém';
        if (wanted) {
          const admins = await this.listAdmins();
          const found = admins.find((a) => a.id === wanted);
          if (!found) throw new BadRequestException('Escolha alguém da Inovação ou um administrador.');
          name = found.name;
        }
        await this.prisma.$transaction([
          this.prisma.supportTicket.update({ where: { id }, data: { assigneeId: wanted }, select: { id: true } }),
          this.prisma.supportMessage.create({
            data: { ticketId: id, authorId: user.id, kind: 'system_admin', body: `Responsável: ${name} (definido por ${user.name}).` },
          }),
        ]);
        if (wanted && wanted !== user.id) {
          await this.notifyUsers([wanted], id, 'support_assigned', `Chamado #${ticket.number} é seu`, `${user.name} deixou o chamado "${ticket.title}" com você.`);
        }
      }
    }

    if (body.status !== undefined) {
      if (!isOneOf(TICKET_STATUSES, body.status)) throw new BadRequestException('Status inválido.');
      if (body.status !== ticket.status) {
        await this.applyStatus(id, body.status, user, { silent: false, needsAdmin: false, authorUnread: true });
        if (ticket.authorId !== user.id) {
          await this.notifyUsers([ticket.authorId], id, 'support_reply', `Chamado #${ticket.number}: ${STATUS_LABELS[body.status]}`, `O status do chamado "${ticket.title}" agora é ${STATUS_LABELS[body.status]}.`);
        }
      }
    }
    return { ok: true };
  }

  /** Quem abriu confirma que foi resolvido ("Sim, obrigado" / "Sim, concordo"). */
  async confirm(id: string, user: User) {
    const ticket = await this.ownTicket(id, user);
    if (!isClosed(ticket.status)) throw new BadRequestException('Este chamado ainda não foi encerrado.');
    if (ticket.authorConfirmed) return { ok: true };
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId: id, authorId: user.id, kind: 'message', body: ticket.status === 'resolved' ? 'Sim, obrigado.' : 'Sim, concordo.' },
      }),
      this.prisma.supportTicket.update({ where: { id }, data: { authorConfirmed: true, needsAdmin: false }, select: { id: true } }),
    ]);
    return { ok: true };
  }

  /** Quem abriu diz que ainda acontece: reabre. */
  async reopen(id: string, user: User) {
    const ticket = await this.ownTicket(id, user);
    if (!isClosed(ticket.status)) throw new BadRequestException('Este chamado já está aberto.');
    await this.prisma.supportMessage.create({ data: { ticketId: id, authorId: user.id, kind: 'message', body: 'Ainda acontece.' } });
    await this.applyStatus(id, 'open', user, { silent: false, needsAdmin: true, authorUnread: false });
    if (ticket.mainTicketId) {
      await this.prisma.supportTicket.update({ where: { id: ticket.mainTicketId }, data: { needsAdmin: true, updatedAt: new Date() }, select: { id: true } });
    }
    await this.notifyStaffOfAuthorReply(user, ticket);
    return { ok: true };
  }

  // ---------- juntar chamados ----------

  async merge(user: User, body: Record<string, unknown>) {
    this.requireAdmin(user);
    const mainId = typeof body.mainId === 'string' ? body.mainId : '';
    const ids = Array.isArray(body.ticketIds) ? [...new Set(body.ticketIds.filter((v): v is string => typeof v === 'string'))] : [];
    const childIds = ids.filter((v) => v !== mainId);
    if (!mainId || childIds.length === 0) throw new BadRequestException('Escolha o chamado principal e pelo menos mais um para juntar.');
    if (childIds.length > MAX_MERGE) throw new BadRequestException(`Dá para juntar até ${MAX_MERGE} chamados de uma vez.`);

    const main = await this.prisma.supportTicket.findUnique({
      where: { id: mainId },
      select: { id: true, number: true, status: true, closedAt: true, mainTicketId: true },
    });
    if (!main) throw new NotFoundException('Chamado principal não encontrado.');
    if (main.mainTicketId) throw new BadRequestException('O chamado principal já está ligado a outro. Escolha o principal do grupo.');

    const children = await this.prisma.supportTicket.findMany({
      where: { id: { in: childIds } },
      select: { id: true, number: true, authorId: true, linkedTickets: { select: { id: true } } },
    });
    if (children.length !== childIds.length) throw new NotFoundException('Algum chamado não foi encontrado.');

    for (const child of children) {
      // Se o que vai ser ligado já era principal de outros, eles passam para o novo principal.
      const grandchildren = child.linkedTickets.map((g) => g.id);
      await this.prisma.$transaction([
        ...(grandchildren.length ? [this.prisma.supportTicket.updateMany({ where: { id: { in: grandchildren } }, data: { mainTicketId: main.id } })] : []),
        this.prisma.supportTicket.update({
          where: { id: child.id },
          data: { mainTicketId: main.id, status: main.status, closedAt: main.closedAt, needsAdmin: false, authorUnread: child.authorId !== user.id },
          select: { id: true },
        }),
        this.prisma.supportMessage.create({ data: { ticketId: child.id, authorId: null, kind: 'system', body: LINKED_NOTICE } }),
        this.prisma.supportMessage.create({
          data: { ticketId: child.id, authorId: user.id, kind: 'system_admin', body: `Ligado ao chamado #${main.number} por ${user.name}.` },
        }),
      ]);
      await this.notifyUsers([child.authorId].filter((a) => a !== user.id), child.id, 'support_reply', `Chamado #${child.number}: ligado a um problema em tratamento`, LINKED_NOTICE);
    }
    await this.prisma.supportMessage.create({
      data: {
        ticketId: main.id,
        authorId: user.id,
        kind: 'system_admin',
        body: `${user.name} ligou ${children.length === 1 ? 'o chamado' : 'os chamados'} ${children.map((c) => `#${c.number}`).join(', ')} a este.`,
      },
    });
    await this.prisma.supportTicket.update({ where: { id: main.id }, data: { updatedAt: new Date() }, select: { id: true } });
    return { ok: true, linked: children.length };
  }

  async unlink(id: string, user: User) {
    this.requireAdmin(user);
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id }, select: { id: true, number: true, mainTicketId: true } });
    if (!ticket) throw new NotFoundException('Chamado não encontrado.');
    if (!ticket.mainTicketId) throw new BadRequestException('Este chamado não está ligado a outro.');
    await this.prisma.$transaction([
      this.prisma.supportTicket.update({ where: { id }, data: { mainTicketId: null, needsAdmin: true }, select: { id: true } }),
      this.prisma.supportMessage.create({
        data: { ticketId: id, authorId: user.id, kind: 'system_admin', body: `Desligado do grupo por ${user.name}. Volta a ser atendido sozinho.` },
      }),
    ]);
    return { ok: true };
  }

  // ---------- limpeza (chamada pela retenção) ----------

  /** Apaga os ARQUIVOS dos anexos de chamados encerrados há mais de `days` dias. O texto continua e cada anexo fica registrado (nome e tamanho) como apagado. */
  async cleanOldAttachments(days: number): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const tickets = await this.prisma.supportTicket.findMany({
      where: { closedAt: { lt: cutoff }, attachmentsCleanedAt: null, status: { in: ['resolved', 'not_issue'] } },
      select: { id: true },
      take: 200,
    });
    let cleaned = 0;
    for (const ticket of tickets) {
      await rm(supportTicketDir(ticket.id), { recursive: true, force: true });
      await this.prisma.$transaction([
        this.prisma.supportAttachment.updateMany({ where: { message: { ticketId: ticket.id }, removedAt: null }, data: { removedAt: new Date() } }),
        this.prisma.supportTicket.update({ where: { id: ticket.id }, data: { attachmentsCleanedAt: new Date() }, select: { id: true } }),
      ]);
      cleaned += 1;
    }
    if (cleaned > 0) this.logger.log(`Anexos de ${cleaned} chamado(s) encerrado(s) há mais de ${days} dia(s) apagados.`);
    return cleaned;
  }

  // ---------- internos ----------

  private requireAdmin(user: User) {
    if (!isAdmin(user)) throw new ForbiddenException('Só administradores.');
  }

  private async ownTicket(id: string, user: User) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: { id: true, number: true, title: true, status: true, authorId: true, authorConfirmed: true, assigneeId: true, mainTicketId: true },
    });
    if (!ticket || ticket.authorId !== user.id) throw new NotFoundException('Chamado não encontrado.');
    return ticket;
  }

  private listAdmins() {
    return this.prisma.user.findMany({
      where: { isActive: true, OR: [{ role: 'admin' }, { departments: { has: 'inovacao' } }] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  private toRow(t: TicketRow, admin: boolean) {
    return {
      id: t.id,
      number: t.number,
      type: t.type,
      subject: t.subject,
      urgency: t.urgency,
      status: t.status,
      title: t.title,
      hubArea: t.hubArea,
      robot: t.robot,
      dashboard: t.dashboard,
      executionId: t.executionId,
      authorUnread: t.authorUnread,
      authorConfirmed: t.authorConfirmed,
      attachmentsCleanedAt: t.attachmentsCleanedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      closedAt: t.closedAt,
      // Só administradores veem quem abriu, de qual departamento, o responsável e as ligações.
      ...(admin
        ? {
            author: { id: t.author.id, name: t.author.name, departments: t.author.departments },
            assignee: t.assignee,
            needsAdmin: t.needsAdmin,
            mainTicketId: t.mainTicketId,
            linkedCount: t._count.linkedTickets,
          }
        : {}),
    };
  }

  /**
   * Muda o status (e o que acompanha: fechado em, aviso para quem abriu, fila da Inovação), escreve a linha no histórico e
   * repassa aos chamados ligados quando este é o principal.
   */
  private async applyStatus(
    id: string,
    status: TicketStatus,
    actor: Actor,
    opts: { silent: boolean; needsAdmin: boolean; authorUnread: boolean },
  ) {
    const closedAt = isClosed(status) ? new Date() : null;
    const data = {
      status,
      closedAt,
      needsAdmin: opts.needsAdmin,
      authorUnread: opts.authorUnread,
      authorConfirmed: false,
      updatedAt: new Date(),
    };
    const current = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: { status: true, closedAt: true, linkedTickets: { select: { id: true, authorId: true } } },
    });
    if (!current) return;
    await this.prisma.supportTicket.update({
      where: { id },
      data: { ...data, closedAt: isClosed(status) ? (isClosed(current.status) ? current.closedAt ?? closedAt : closedAt) : null },
      select: { id: true },
    });
    if (opts.silent || status === current.status) {
      return;
    }
    await this.prisma.supportMessage.create({
      data: { ticketId: id, authorId: actor.id, kind: 'system', body: `Status alterado para: ${STATUS_LABELS[status]}.` },
    });
    for (const child of current.linkedTickets) {
      await this.prisma.supportTicket.update({
        where: { id: child.id },
        data: { status, closedAt: isClosed(status) ? new Date() : null, authorUnread: true, authorConfirmed: false, needsAdmin: false },
        select: { id: true },
      });
      await this.prisma.supportMessage.create({
        data: { ticketId: child.id, authorId: actor.id, kind: 'system', body: `Status alterado para: ${STATUS_LABELS[status]}.` },
      });
    }
  }

  private async copyReplyToLinked(
    childId: string,
    actor: Actor,
    text: string,
    attachments: Array<{ fileName: string; mimeType: string; size: number; storagePath: string; isImage: boolean }>,
  ) {
    const message = await this.prisma.supportMessage.create({
      data: { ticketId: childId, authorId: actor.id, kind: 'message', body: text },
      select: { id: true },
    });
    if (attachments.length) {
      const dir = supportTicketDir(childId);
      await mkdir(dir, { recursive: true });
      const rows: Prisma.SupportAttachmentCreateManyInput[] = [];
      for (const a of attachments) {
        const stored = uniqueStoredFileName(a.fileName);
        await copyFile(join(storageRoot, a.storagePath), join(dir, stored));
        rows.push({ messageId: message.id, fileName: a.fileName, mimeType: a.mimeType, size: a.size, isImage: a.isImage, storagePath: `support/${childId}/${stored}` });
      }
      await this.prisma.supportAttachment.createMany({ data: rows });
    }
    await this.prisma.supportTicket.update({ where: { id: childId }, data: { authorUnread: true, needsAdmin: false, updatedAt: new Date() }, select: { id: true } });
  }

  private checkUploads(files: SupportUpload[]) {
    if (files.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`Dá para anexar até ${MAX_ATTACHMENTS} arquivos por mensagem.`);
    }
    return files.map((file) => {
      const fileName = sanitizeFileName(fixMulterFilename(file.originalname ?? 'arquivo')) || 'arquivo';
      const check = checkAttachment(fileName, file.size ?? 0);
      if (!check.ok) throw new BadRequestException(check.reason);
      if (!file.path) throw new BadRequestException(`"${fileName}" não chegou ao servidor. Tente de novo.`);
      return { path: file.path, fileName, size: file.size ?? 0, isImage: check.isImage, mimeType: check.mimeType };
    });
  }

  private async storeAttachments(
    ticketId: string,
    messageId: string,
    files: Array<{ path: string; fileName: string; size: number; isImage: boolean; mimeType: string }>,
  ) {
    if (!files.length) return [];
    const dir = supportTicketDir(ticketId);
    await mkdir(dir, { recursive: true });
    const saved: Array<{ fileName: string; mimeType: string; size: number; storagePath: string; isImage: boolean }> = [];
    for (const file of files) {
      const stored = uniqueStoredFileName(file.fileName);
      try {
        await rename(file.path, join(dir, stored));
      } catch {
        // tmpdir e storage em discos diferentes: rename não atravessa; copia e apaga.
        await copyFile(file.path, join(dir, stored));
        await rm(file.path, { force: true });
      }
      saved.push({ fileName: file.fileName, mimeType: file.mimeType, size: file.size, isImage: file.isImage, storagePath: `support/${ticketId}/${stored}` });
    }
    await this.prisma.supportAttachment.createMany({ data: saved.map((s) => ({ ...s, messageId })) });
    return saved;
  }

  private async discardTemp(files: SupportUpload[]) {
    await Promise.all(files.filter((f) => f.path).map((f) => rm(f.path!, { force: true }).catch(() => undefined)));
  }

  /** Foto da execução na hora de abrir: erro, parâmetros SEM senhas e o fim do log. Só de execução que a pessoa pode ver. */
  private async snapshotExecution(user: User, executionId: string) {
    const execution = await this.prisma.execution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        userId: true,
        scheduledTaskId: true,
        status: true,
        errorMessage: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        inputJson: true,
        user: { select: { departments: true } },
        robot: { select: { id: true, name: true, schema: true, allowedDepartments: true, allowedUserIds: true } },
      },
    });
    if (!execution || !canAccessExecution(user, execution) || !canAccessRobot(user, execution.robot)) {
      return null;
    }
    const parameters =
      execution.inputJson && typeof execution.inputJson === 'object' && !Array.isArray(execution.inputJson)
        ? (execution.inputJson as Record<string, unknown>)
        : {};
    const secrets = new Set(secretParameterNames(execution.robot.schema, parameters));
    const safe = Object.fromEntries(Object.entries(parameters).filter(([name]) => !secrets.has(name)));
    const logs = await this.prisma.executionLog.findMany({
      where: { executionId },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: 30,
      select: { level: true, message: true, timestamp: true },
    });
    return {
      executionId: execution.id,
      robotId: execution.robot.id,
      context: {
        executionId: execution.id,
        robotName: execution.robot.name,
        status: execution.status,
        errorMessage: execution.errorMessage,
        createdAt: execution.createdAt,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        parameters: safe,
        hiddenParameters: [...secrets],
        logTail: logs.reverse().map((l) => ({ level: l.level, message: l.message.slice(0, 500), timestamp: l.timestamp })),
      },
    };
  }

  // ---------- notificações (o aviso é só dentro do Hub: sem e-mail) ----------

  private async notifyAdmins(exceptUserId: string, ticketId: string, type: string, title: string, body: string) {
    const admins = await this.listAdmins();
    await this.notifyUsers(admins.map((a) => a.id).filter((a) => a !== exceptUserId), ticketId, type, title, body);
  }

  private async notifyStaffOfAuthorReply(
    author: Actor,
    ticket: { id: string; number: number; title: string; assigneeId: string | null },
  ) {
    const title = `Chamado #${ticket.number}: ${author.name} respondeu`;
    const body = `Nova mensagem em "${ticket.title}".`;
    if (ticket.assigneeId && ticket.assigneeId !== author.id) {
      await this.notifyUsers([ticket.assigneeId], ticket.id, 'support_author_reply', title, body);
    } else if (!ticket.assigneeId) {
      await this.notifyAdmins(author.id, ticket.id, 'support_author_reply', title, body);
    }
  }

  private async notifyUsers(userIds: string[], ticketId: string, type: string, title: string, body: string) {
    const unique = [...new Set(userIds)];
    if (!unique.length) return;
    try {
      await this.prisma.notification.createMany({
        data: unique.map((userId) => ({ userId, type, title, body, supportTicketId: ticketId })),
      });
    } catch (error) {
      // Aviso é conforto: nunca derruba a resposta do chamado.
      this.logger.warn(`Não consegui criar notificação do Suporte: ${(error as Error).message}`);
    }
  }
}
