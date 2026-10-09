import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateExternalMetricDto,
  ExternalMetricsService,
} from './external-metrics.service';

@ApiTags('Métricas Externas (chave x-metrics-key)')
@Controller('metrics/external')
export class ExternalMetricsController {
  private readonly apiKey: string | undefined;

  constructor(private readonly service: ExternalMetricsService) {
    this.apiKey = process.env.EXTERNAL_METRICS_API_KEY;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async record(
    @Headers('x-metrics-key') key: string | undefined,
    @Body() body: CreateExternalMetricDto,
  ) {
    if (!this.apiKey || key !== this.apiKey) {
      throw new UnauthorizedException('API key inválida');
    }

    if (!body.source || !body.action) {
      throw new Error('source e action são obrigatórios');
    }

    const metric = await this.service.record(body);
    return { ok: true, id: metric.id, manualEstimatedSeconds: metric.manualEstimatedSeconds };
  }
}
