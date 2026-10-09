import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';

@ApiTags('Integrações (Robôs Externos)')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('time-savings')
  async ingestTimeSavings(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const apiKey = extractBearerToken(authHeader);
    if (!apiKey) {
      throw new UnauthorizedException(
        'Informe a chave de API no header Authorization: Bearer <chave>.',
      );
    }

    const robot = await this.integrationsService.authenticateRobot(apiKey);

    const result = await this.integrationsService.ingestTimeSavings(robot, {
      secondsSaved: toNumber(body.secondsSaved),
      userName: typeof body.userName === 'string' ? body.userName : undefined,
      userLogin: typeof body.userLogin === 'string' ? body.userLogin : undefined,
      unitsProcessed: toNumber(body.unitsProcessed),
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
    });

    return {
      success: true,
      executionId: result.execution.id,
      deduplicated: result.deduplicated,
    };
  }
}

function extractBearerToken(header?: string) {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length).trim();
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return undefined;
}
