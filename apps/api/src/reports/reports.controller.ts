import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import {
  ReportsService,
  type ExecutionsQueryInput,
  type ExecutionsSortField,
  type ReportOriginFilter,
} from './reports.service';
import type { Granularity } from './time-savings-metrics';

type RawQuery = Record<string, string | undefined>;

const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];
const SORT_FIELDS: ExecutionsSortField[] = ['at', 'robot', 'user', 'department', 'units', 'saved'];
const ORIGINS: ReportOriginFilter[] = ['hub', 'external'];

function parseFilters(query: RawQuery) {
  const userIds = query.userIds
    ? query.userIds.split(',').map((id) => id.trim()).filter(Boolean)
    : undefined;
  return {
    from: query.from,
    to: query.to,
    robotId: query.robotId || undefined,
    userIds,
    department: query.department || undefined,
    origin: ORIGINS.includes(query.origin as ReportOriginFilter)
      ? (query.origin as ReportOriginFilter)
      : undefined,
    granularity: GRANULARITIES.includes(query.granularity as Granularity)
      ? (query.granularity as Granularity)
      : undefined,
  };
}

function parseExecutionsQuery(query: RawQuery): ExecutionsQueryInput {
  const toInt = (value: string | undefined) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    ...parseFilters(query),
    search: query.search,
    includeZero: query.includeZero === 'true',
    outliersOnly: query.outliersOnly === 'true',
    sort: SORT_FIELDS.includes(query.sort as ExecutionsSortField)
      ? (query.sort as ExecutionsSortField)
      : undefined,
    dir: query.dir === 'asc' ? 'asc' : 'desc',
    page: toInt(query.page),
    pageSize: toInt(query.pageSize),
  };
}

@ApiTags('Relatórios')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly authService: AuthService,
  ) {}

  @Get('time-savings')
  async getTimeSavings(@Req() request: Request, @Query() query: RawQuery) {
    const user = await this.authService.requireUser(request);
    return this.reportsService.getTimeSavingsReport(user, parseFilters(query));
  }

  // Lista paginada no servidor (ou CSV completo com format=csv).
  @Get('time-savings/executions')
  async getTimeSavingsExecutions(
    @Req() request: Request,
    @Query() query: RawQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.authService.requireUser(request);
    const parsed = parseExecutionsQuery(query);

    if (query.format === 'csv') {
      const { csv, range } = await this.reportsService.exportTimeSavingsExecutionsCsv(user, parsed);
      const suffix = range ? `${range.from}_a_${range.to}` : 'historico';
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="tempo-ganho-execucoes_${suffix}.csv"`,
      );
      return csv;
    }

    return this.reportsService.getTimeSavingsExecutions(user, parsed);
  }
}
