import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, SiteCategory, SiteStatus, type User, UserRole } from '@prisma/client';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessSite, normalizeDepartments } from '../shared/access';
import { insecureGet } from '../shared/insecure-http';
import { ensureSiteDir, siteRoot } from '../shared/storage';
import { SiteHealthCheckService } from './site-health-check.service';

export type SiteUpsertInput = {
  id?: string;
  name?: string;
  url?: string;
  description?: string;
  category?: SiteCategory;
  maintenanceOverride?: boolean;
  order?: number;
  allowedDepartments?: string[];
  minRole?: UserRole;
  powerbiGroupId?: string | null;
  powerbiDatasetId?: string | null;
  powerbiScheduledTimes?: string[];
  powerbiShowRefresh?: boolean;
  ssoEnabled?: boolean;
  // undefined = não alterar; null = desvincular.
  linkedDashboardId?: string | null;
};

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

const FAVICON_FILENAME = 'favicon';

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly healthCheck: SiteHealthCheckService,
  ) {}

  async findAll(user: Pick<User, 'id' | 'role' | 'departments'>) {
    const sites = await this.prisma.site.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });

    return sites.filter((site) => canAccessSite(user, site)).map(withHasFavicon);
  }

  async findOne(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    return site ? withHasFavicon(site) : null;
  }

  async saveSite(input: SiteUpsertInput) {
    const name = input.name?.trim();
    const url = input.url?.trim();

    if (!name) {
      throw new BadRequestException('Nome do site é obrigatório.');
    }

    if (!url) {
      throw new BadRequestException('URL do site é obrigatória.');
    }

    const slug = normalizeSlug(name);
    if (!slug) {
      throw new BadRequestException('Não foi possível gerar um identificador para este site.');
    }

    const duplicate = await this.prisma.site.findFirst({
      where: {
        slug,
        NOT: input.id ? { id: input.id } : undefined,
      },
    });

    if (duplicate) {
      throw new BadRequestException('Já existe um site com este nome.');
    }

    const maintenanceOverride = input.maintenanceOverride ?? false;

    const payload: Prisma.SiteUncheckedCreateInput = {
      slug,
      name,
      url,
      description: input.description?.trim() || null,
      category: input.category === SiteCategory.bi ? SiteCategory.bi : SiteCategory.sistema,
      maintenanceOverride,
      order: sanitizeInt(input.order, { min: 0, max: 10_000 }) ?? 0,
      status: maintenanceOverride ? SiteStatus.maintenance : SiteStatus.online,
      allowedDepartments: normalizeDepartments(input.allowedDepartments),
      minRole: input.minRole === UserRole.manager ? UserRole.manager : UserRole.employee,
      powerbiGroupId: extractGuid(input.powerbiGroupId, 'groups'),
      powerbiDatasetId: extractGuid(input.powerbiDatasetId, 'datasets'),
      powerbiScheduledTimes: Array.isArray(input.powerbiScheduledTimes) ? input.powerbiScheduledTimes : [],
      powerbiShowRefresh: input.powerbiShowRefresh !== false,
      ssoEnabled: input.ssoEnabled === true,
    };

    if (input.linkedDashboardId !== undefined) {
      if (input.linkedDashboardId !== null) {
        if (payload.category !== SiteCategory.bi) {
          throw new BadRequestException('Só BIs podem ser vinculados a um painel.');
        }
        const dashboard = await this.prisma.dashboard.findUnique({
          where: { id: input.linkedDashboardId },
          select: { id: true, type: true },
        });
        if (!dashboard) {
          throw new BadRequestException('Painel vinculado não encontrado.');
        }
        if (dashboard.type !== 'server') {
          throw new BadRequestException('Só painéis do tipo servidor (com chat de IA próprio) podem ser vinculados.');
        }
      }
      payload.linkedDashboardId = input.linkedDashboardId;
    }

    let wasUnderMaintenance = false;
    if (input.id) {
      const existing = await this.prisma.site.findUnique({
        where: { id: input.id },
        select: { id: true, maintenanceOverride: true },
      });
      if (!existing) {
        throw new BadRequestException('Site não encontrado.');
      }
      wasUnderMaintenance = existing.maintenanceOverride;
    }

    const site = input.id
      ? await this.prisma.site.update({ where: { id: input.id }, data: payload })
      : await this.prisma.site.create({ data: payload });

    if (wasUnderMaintenance && !maintenanceOverride) {
      void this.healthCheck.checkOne(site);
    }

    return withHasFavicon(site);
  }

  async recheckSite(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new BadRequestException('Site não encontrado.');
    }

    await this.healthCheck.checkOne(site);
    const updated = await this.prisma.site.findUnique({ where: { id } });
    return updated ? withHasFavicon(updated) : null;
  }

  async updatePowerBIStatus(
    id: string,
    status: string | null,
    requestId?: string,
    lastRefreshAt?: Date,
  ) {
    await this.prisma.site.update({
      where: { id },
      data: {
        powerbiRefreshStatus: status,
        ...(requestId !== undefined ? { powerbiRefreshRequestId: requestId } : {}),
        ...(lastRefreshAt !== undefined ? { powerbiLastRefreshAt: lastRefreshAt } : {}),
      },
    });
  }

  async createRefreshLog(siteId: string, user: { name: string; email: string }) {
    return this.prisma.powerBIRefreshLog.create({
      data: { siteId, requestedByName: user.name, requestedByEmail: user.email, status: 'Unknown' },
    });
  }

  async resolveRefreshLog(siteId: string, status: string, completedAt: Date) {
    const log = await this.prisma.powerBIRefreshLog.findFirst({
      where: { siteId, status: { in: ['Unknown', 'InProgress'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (!log) return;
    await this.prisma.powerBIRefreshLog.update({
      where: { id: log.id },
      data: { status, completedAt },
    });
  }

  async findRefreshLogs(limit = 100) {
    return this.prisma.powerBIRefreshLog.findMany({
      take: limit,
      orderBy: { requestedAt: 'desc' },
      include: { site: { select: { id: true, name: true } } },
    });
  }

  async findAllPowerBISites() {
    return this.prisma.site.findMany({
      where: {
        powerbiGroupId: { not: null },
        powerbiDatasetId: { not: null },
      },
      select: {
        id: true,
        name: true,
        powerbiGroupId: true,
        powerbiDatasetId: true,
        powerbiRefreshStatus: true,
        powerbiLastRefreshAt: true,
        updatedAt: true,
      },
    });
  }

  async findPendingPowerBIRefreshes() {
    return this.prisma.site.findMany({
      where: {
        powerbiRefreshStatus: { in: ['Unknown', 'InProgress'] },
        powerbiGroupId: { not: null },
        powerbiDatasetId: { not: null },
      },
      select: {
        id: true,
        powerbiGroupId: true,
        powerbiDatasetId: true,
        powerbiRefreshRequestId: true,
      },
    });
  }

  async deleteSite(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new BadRequestException('Site não encontrado.');
    }

    await this.prisma.site.delete({ where: { id } });
    await rm(siteRoot(id), { recursive: true, force: true });
    return { success: true };
  }

  async saveFavicon(id: string, file?: UploadedFile) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new BadRequestException('Site não encontrado.');
    }

    if (!file?.buffer) {
      throw new BadRequestException('Envie um arquivo de imagem.');
    }

    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('O favicon precisa ser um arquivo de imagem.');
    }

    await ensureSiteDir(id);
    await writeFile(join(siteRoot(id), FAVICON_FILENAME), file.buffer);

    const updated = await this.prisma.site.update({
      where: { id },
      data: {
        faviconStoragePath: `sites/${id}/${FAVICON_FILENAME}`,
        faviconMimeType: file.mimetype,
      },
    });

    return withHasFavicon(updated);
  }

  async removeFavicon(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new BadRequestException('Site não encontrado.');
    }

    await rm(join(siteRoot(id), FAVICON_FILENAME), { force: true });

    const updated = await this.prisma.site.update({
      where: { id },
      data: { faviconStoragePath: null, faviconMimeType: null },
    });

    return withHasFavicon(updated);
  }

  async getFavicon(id: string): Promise<{ contentType: string; buffer: Buffer } | null> {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: { url: true, faviconStoragePath: true, faviconMimeType: true },
    });
    if (!site) {
      return null;
    }

    if (site.faviconStoragePath) {
      try {
        const buffer = await readFile(join(process.cwd(), 'storage', site.faviconStoragePath));
        return { contentType: site.faviconMimeType || 'image/x-icon', buffer };
      } catch {
        // arquivo customizado sumiu do disco — cai pro fallback automático abaixo
      }
    }

    return fetchFavicon(site.url);
  }
}

function withHasFavicon<T extends { faviconStoragePath: string | null }>(site: T) {
  return { ...site, hasFavicon: Boolean(site.faviconStoragePath) };
}

const FETCH_TIMEOUT_MS = 5000;

async function fetchFavicon(siteUrl: string): Promise<{ contentType: string; buffer: Buffer } | null> {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return null;
  }

  const iconUrl = (await resolveIconUrl(origin)) ?? `${origin}/favicon.ico`;
  return downloadImage(iconUrl);
}

// Sites que não expõem /favicon.ico geralmente declaram o ícone via <link rel="icon"> no <head>
async function resolveIconUrl(origin: string): Promise<string | null> {
  const response = await insecureGet(origin, FETCH_TIMEOUT_MS);
  if (!response || response.statusCode >= 400) {
    return null;
  }

  const html = response.body.toString('utf-8');
  const match = html.match(
    /<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["']/i,
  );
  if (!match) {
    return null;
  }

  try {
    return new URL(match[1], origin).toString();
  } catch {
    return null;
  }
}

async function downloadImage(url: string): Promise<{ contentType: string; buffer: Buffer } | null> {
  const response = await insecureGet(url, FETCH_TIMEOUT_MS);
  if (!response || response.statusCode >= 400) {
    return null;
  }

  const contentType = response.contentType || 'image/x-icon';
  if (!contentType.startsWith('image/')) {
    return null;
  }

  return { contentType, buffer: response.body };
}

function sanitizeInt(value: number | null | undefined, bounds: { min: number; max: number }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

function extractGuid(value: string | null | undefined, urlSegment?: 'groups' | 'datasets'): string | null {
  if (!value) return null;
  // Se a entrada parece uma URL do Power BI, extrai o UUID do segmento correto.
  if (urlSegment) {
    const match = value.match(new RegExp(`/${urlSegment}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`, 'i'));
    if (match) return match[1].toLowerCase();
  }
  // Fallback: primeiro UUID encontrado (entrada manual limpa).
  const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toLowerCase() : null;
}

function normalizeSlug(value: string) {
  return value
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
