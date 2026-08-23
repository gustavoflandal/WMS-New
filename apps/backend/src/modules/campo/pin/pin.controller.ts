// DOC-12 RF-SEG-004 / DOC-15 RF-COL-030 — PIN de re-bloqueio por inatividade.
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { PinService } from './pin.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { Authenticated } from '../../../core/rbac/decorators/authenticated.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import type { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';

interface SetPinBody {
  pin: string;
}

interface VerifyPinBody {
  pin: string;
  warehouse_id: string;
}

@Controller('campo/pin')
@UseGuards(PermissionGuard)
export class PinController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(PinService) private readonly pinService: PinService) {}

  @Authenticated()
  @Post()
  setPin(@Body() body: SetPinBody, @CurrentUser() principal: RequestPrincipal) {
    return this.pinService.setPin(principal.userId, body.pin);
  }

  @Authenticated()
  @Post('verificar')
  verifyPin(@Body() body: VerifyPinBody, @CurrentUser() principal: RequestPrincipal) {
    return this.pinService.verifyPin(principal.userId, body.pin, body.warehouse_id);
  }
}
