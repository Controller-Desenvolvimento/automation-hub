import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { isAdmin } from '../shared/access';
import { diskUploadLimits } from '../shared/upload';
import { ExecutionRunnerService } from './execution-runner.service';
import { ExecutionsService } from './executions.service';

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  path?: string;
};

@ApiTags('Execuções')
@ApiBearerAuth()
@Controller('executions')
export class ExecutionsController {
  constructor(
    private readonly executionsService: ExecutionsService,
    private readonly executionRunnerService: ExecutionRunnerService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async listExecutions(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.executionsService.listExecutions(user);
  }

  @Get('results')
  async listResults(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.executionsService.listResults(user);
  }

  @Get(':id')
  async getExecution(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.executionsService.getExecution(id, user);
  }

  @Post()
  @UseInterceptors(AnyFilesInterceptor(diskUploadLimits))
  async createExecution(
    @Req() request: Request,
    @Body() body: Record<string, string | undefined>,
    @UploadedFiles() files: UploadedFile[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    const parameters = parseParameters(body.parameters);

    // Priority vem do cliente: só admin pode furar a fila, e sempre saneado
    // (Number('abc') = NaN quebraria o Prisma com 500)
    const rawPriority = Number(body.priority ?? 0);
    const priority =
      isAdmin(user) && Number.isFinite(rawPriority)
        ? Math.max(0, Math.min(100, Math.round(rawPriority)))
        : 0;

    return this.executionsService.createExecution(
      body.robotId ?? '',
      {
        userId: user.id,
        notes: body.notes,
        priority,
        parameters,
      },
      files,
    );
  }

  @Post(':id/cancel')
  async cancelExecution(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    const execution = await this.executionsService.cancel(id, user);
    await this.executionRunnerService.stopExecution(id);
    await this.executionsService.log(id, 'warn', 'Execução cancelada pelo usuário.');
    return execution;
  }

  // Rodar de novo com as mesmas entradas. Quem executou ou um administrador (a regra fica no serviço).
  @Post(':id/retry')
  async retryExecution(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.executionsService.retry(id, user);
  }

  // Rodar de novo usando a planilha de saída como entrada (continua de onde parou). `fileName` só é preciso quando a
  // saída tem mais de uma planilha e nenhuma tem o nome da planilha enviada.
  @Post(':id/retry-with-output')
  async retryExecutionWithOutput(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() body?: { fileName?: string },
  ) {
    const user = await this.authService.requireUser(request);
    const fileName = typeof body?.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : undefined;
    return this.executionsService.retryWithOutputSpreadsheet(id, user, fileName);
  }
}

function parseParameters(parametersJson?: string) {
  if (!parametersJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(parametersJson) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
