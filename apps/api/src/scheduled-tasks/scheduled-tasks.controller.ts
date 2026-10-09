import {
  Body,
  Controller,
  Delete,
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
import { uploadLimits } from '../shared/upload';
import { ScheduledTasksService } from './scheduled-tasks.service';

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

@ApiTags('Agendamentos')
@ApiBearerAuth()
@Controller('scheduled-tasks')
export class ScheduledTasksController {
  constructor(
    private readonly scheduledTasksService: ScheduledTasksService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async listTasks(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.scheduledTasksService.listTasks(user);
  }

  @Post()
  @UseInterceptors(AnyFilesInterceptor(uploadLimits))
  async saveTask(
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: UploadedFile[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    return this.scheduledTasksService.saveTask(
      user,
      {
        id: typeof body.id === 'string' ? body.id : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        robotId: typeof body.robotId === 'string' ? body.robotId : undefined,
        frequency: typeof body.frequency === 'string' ? body.frequency : undefined,
        timeOfDay: typeof body.timeOfDay === 'string' ? body.timeOfDay : undefined,
        timesOfDay: parseStringArray(body.timesOfDay),
        startDate: typeof body.startDate === 'string' ? body.startDate : undefined,
        dayOfWeek:
          typeof body.dayOfWeek === 'number'
            ? body.dayOfWeek
            : typeof body.dayOfWeek === 'string' && body.dayOfWeek !== ''
              ? Number(body.dayOfWeek)
              : null,
        dayOfMonth:
          typeof body.dayOfMonth === 'number'
            ? body.dayOfMonth
            : typeof body.dayOfMonth === 'string' && body.dayOfMonth !== ''
              ? Number(body.dayOfMonth)
              : null,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        parameters: parseParameters(body.parameters),
        isActive: typeof body.isActive === 'boolean' ? body.isActive : String(body.isActive) === 'true',
        recipientScope: typeof body.recipientScope === 'string' ? body.recipientScope : undefined,
        recipientDepartments: parseStringArray(body.recipientDepartments),
        recipientUserIds: parseStringArray(body.recipientUserIds),
        creditMode: typeof body.creditMode === 'string' ? body.creditMode : undefined,
        creditUserIds: parseStringArray(body.creditUserIds),
        creditDepartment: typeof body.creditDepartment === 'string' ? body.creditDepartment : undefined,
      },
      files,
    );
  }

  @Delete(':id')
  async deleteTask(@Req() request: Request, @Param('id') id: string) {
    const user = await this.authService.requireUser(request);
    return this.scheduledTasksService.deleteTask(user, id);
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return [];
    }
  }
  return [];
}

function parseParameters(value: unknown) {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}
