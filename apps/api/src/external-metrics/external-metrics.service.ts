import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CreateExternalMetricDto = {
  source: string;
  sourceName?: string;
  action: string;
  label?: string;
  unitLabel?: string;
  userName?: string;
  userEmail?: string;
  department?: string;
  unitsProcessed?: number;
  manualSecondsPerUnit?: number;
};

@Injectable()
export class ExternalMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(dto: CreateExternalMetricDto) {
    const units = Math.max(1, Math.round(dto.unitsProcessed ?? 1));
    const secsPerUnit = Math.max(0, Math.round(dto.manualSecondsPerUnit ?? 0));
    const manualEstimatedSeconds = secsPerUnit * units;

    return this.prisma.externalMetric.create({
      data: {
        source: dto.source.trim().toLowerCase().replace(/\s+/g, '_'),
        sourceName: dto.sourceName?.trim() || null,
        action: dto.action.trim(),
        label: dto.label?.trim() || null,
        unitLabel: dto.unitLabel?.trim() || 'empresa',
        userName: dto.userName?.trim() || null,
        userEmail: dto.userEmail?.trim().toLowerCase() || null,
        department: dto.department?.trim().toLowerCase() || null,
        unitsProcessed: units,
        manualSecondsPerUnit: secsPerUnit,
        manualEstimatedSeconds,
      },
    });
  }
}
