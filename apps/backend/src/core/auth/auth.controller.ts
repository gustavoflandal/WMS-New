// DOC-12 §4.1 — endpoints de autenticação. RF-SEG-006: login interno e de
// portal são endpoints SEPARADOS (o portal nunca recebe token de área
// INTERNAL). [LACUNA: RBAC DOC-12] resolvido — todas as rotas declaram
// @Public()/@Authenticated() (RN-SEG-012).
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service.js';
import { Public } from '../rbac/decorators/public.decorator.js';
import { Authenticated } from '../rbac/decorators/authenticated.decorator.js';
import { CurrentUser } from '../rbac/decorators/current-user.decorator.js';
import { RequestPrincipal, PermissionGuard } from '../rbac/guards/permission.guard.js';
import { RbacService } from '../rbac/rbac.service.js';

interface LoginBody {
  email: string;
  password: string;
  device_id: string;
  totp_code?: string;
}

interface RefreshBody {
  refresh_token: string;
  device_id: string;
}

interface ChangePasswordBody {
  old_password: string;
  new_password: string;
}

@Controller('auth')
@UseGuards(PermissionGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rbacService: RbacService
  ) {}

  @Public()
  @Post('login')
  async login(@Body() body: LoginBody, @Req() req: Request) {
    return this.authService.login(body.email, body.password, body.device_id, body.totp_code, req.ip);
  }

  @Public()
  @Post('portal/login')
  async loginPortal(@Body() body: LoginBody, @Req() req: Request) {
    return this.authService.loginPortal(body.email, body.password, body.device_id, req.ip);
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() body: RefreshBody) {
    return this.authService.refresh(body.refresh_token, body.device_id);
  }

  @Public()
  @Post('logout')
  async logout(@Body() body: { refresh_token: string }) {
    await this.authService.logout(body.refresh_token);
    return { ok: true };
  }

  @Authenticated()
  @Get('me')
  async me(@CurrentUser() principal: RequestPrincipal) {
    const context = await this.rbacService.getMyContext(principal.userId);
    return { userId: principal.userId, area: principal.area, ...context };
  }

  @Authenticated()
  @Post('change-password')
  async changePassword(@CurrentUser() principal: RequestPrincipal, @Body() body: ChangePasswordBody) {
    await this.authService.changePassword(principal.userId, body.old_password, body.new_password);
    return { ok: true };
  }

  @Authenticated()
  @Post('mfa/enroll')
  async enrollMfa(@CurrentUser() principal: RequestPrincipal) {
    return this.authService.enrollMfa(principal.userId);
  }

  @Authenticated()
  @Post('mfa/confirm')
  async confirmMfa(@CurrentUser() principal: RequestPrincipal, @Body() body: { code: string }) {
    await this.authService.confirmMfa(principal.userId, body.code);
    return { ok: true };
  }
}
