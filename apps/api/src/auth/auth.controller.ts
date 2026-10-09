import { Body, Controller, Get, HttpException, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { effectiveRole } from '../shared/access';
import { AuthService } from './auth.service';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();

  // Evita crescimento indefinido do mapa: descarta janelas já expiradas
  if (rateLimitMap.size > 500) {
    for (const [key, value] of rateLimitMap) {
      if (now > value.resetAt) {
        rateLimitMap.delete(key);
      }
    }
  }

  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return false;
  }
  entry.count++;
  return true;
}

@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(
    @Body()
    body: {
      name?: string;
      email?: string;
      password?: string;
      departments?: unknown;
    },
    @Req() request: Request,
  ) {
    const ip = request.ip ?? 'unknown';
    if (!checkRateLimit(ip)) {
      throw new HttpException('Muitas tentativas. Tente novamente em 1 minuto.', 429);
    }
    return this.authService.register(body);
  }

  @Post('login')
  login(@Body() body: { login?: string; email?: string; password?: string }, @Req() request: Request) {
    const ip = request.ip ?? 'unknown';
    if (!checkRateLimit(ip)) {
      throw new HttpException('Muitas tentativas. Tente novamente em 1 minuto.', 429);
    }
    return this.authService.login(body);
  }

  @Get('me')
  async me(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: effectiveRole(user),
      departments: user.departments,
      mascotSkin: user.mascotSkin,
    };
  }

  @Patch('mascot-skin')
  async updateMascotSkin(@Req() request: Request, @Body() body: { skin?: string }) {
    const user = await this.authService.requireUser(request);
    return this.authService.updateMascotSkin(user.id, body?.skin);
  }

  @Post('logout')
  logout(@Req() request: Request) {
    return this.authService.logout(request);
  }

  @Get('sso')
  async generateSsoToken(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    const token = this.authService.generateSsoToken(user.id);
    return { token };
  }

  @Get('sso-verify')
  async verifySsoToken(@Query('token') token: string) {
    if (!token) throw new UnauthorizedException('Token inválido.');
    const result = await this.authService.verifySsoToken(token);
    if (!result) throw new UnauthorizedException('Token inválido ou expirado.');
    return result;
  }
}
