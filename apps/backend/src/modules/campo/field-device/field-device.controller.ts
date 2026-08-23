// DOC-15 RNF-COL-003 — registro e gestão de dispositivo de campo.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { FieldDeviceService } from './field-device.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { Authenticated } from '../../../core/rbac/decorators/authenticated.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import type { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';

interface RegisterBody {
  device_id: string;
  warehouse_id: string;
  user_agent?: string;
  app_version?: string;
}

interface BlockBody {
  warehouse_id: string;
}

@Controller('campo/dispositivos')
@UseGuards(PermissionGuard)
export class FieldDeviceController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(FieldDeviceService) private readonly fieldDeviceService: FieldDeviceService) {}

  /** RNF-COL-003: registrado no login — qualquer usuário autenticado (não é uma permissão operacional, é pré-requisito do próprio login de campo). */
  @Authenticated()
  @Post()
  register(@Body() body: RegisterBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fieldDeviceService.registerOrTouch({
      deviceId: body.device_id,
      warehouseId: body.warehouse_id,
      userAgent: body.user_agent,
      appVersion: body.app_version,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('COL.DISPOSITIVO_GERIR')
  @Post(':id/bloquear')
  block(@Param('id') id: string, @Body() body: BlockBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fieldDeviceService.block(id, body.warehouse_id, principal.userId);
  }
}
