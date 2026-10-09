import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DevDocsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.devDoc.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
  }

  async create(input: {
    title: string;
    category: string;
    summary: string;
    howToUse: string;
    codeExample?: string;
    language?: string;
    endpoint?: string;
    tags?: string[];
    order?: number;
  }) {
    if (!input.title?.trim()) throw new BadRequestException('Título é obrigatório.');
    if (!input.category?.trim()) throw new BadRequestException('Categoria é obrigatória.');
    if (!input.summary?.trim()) throw new BadRequestException('Resumo é obrigatório.');
    if (!input.howToUse?.trim()) throw new BadRequestException('Campo "Como usar" é obrigatório.');

    const last = await this.prisma.devDoc.findFirst({ orderBy: { order: 'desc' } });

    return this.prisma.devDoc.create({
      data: {
        title: input.title.trim(),
        category: input.category.trim(),
        summary: input.summary.trim(),
        howToUse: input.howToUse.trim(),
        codeExample: input.codeExample?.trim() || null,
        language: input.language?.trim() || null,
        endpoint: input.endpoint?.trim() || null,
        tags: input.tags ?? [],
        order: input.order ?? (last?.order ?? 0) + 1,
      },
    });
  }

  async update(
    id: string,
    input: {
      title?: string;
      category?: string;
      summary?: string;
      howToUse?: string;
      codeExample?: string | null;
      language?: string | null;
      endpoint?: string | null;
      tags?: string[];
      order?: number;
    },
  ) {
    const doc = await this.prisma.devDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Documentação não encontrada.');

    return this.prisma.devDoc.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title.trim() }),
        ...(input.category !== undefined && { category: input.category.trim() }),
        ...(input.summary !== undefined && { summary: input.summary.trim() }),
        ...(input.howToUse !== undefined && { howToUse: input.howToUse.trim() }),
        ...(input.codeExample !== undefined && { codeExample: input.codeExample?.trim() || null }),
        ...(input.language !== undefined && { language: input.language?.trim() || null }),
        ...(input.endpoint !== undefined && { endpoint: input.endpoint?.trim() || null }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.order !== undefined && { order: input.order }),
      },
    });
  }

  async delete(id: string) {
    const doc = await this.prisma.devDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Documentação não encontrada.');
    await this.prisma.devDoc.delete({ where: { id } });
  }
}
