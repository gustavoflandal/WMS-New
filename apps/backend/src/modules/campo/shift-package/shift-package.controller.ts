// DOC-01 §4.6 RF-ARQ-051 — Pacote de Turno (pré-carregamento offline, COL-2B consome).
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ShiftPackageService } from './shift-package.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface ShiftPackageQuery {
  warehouse_id: string;
}

@Controller('campo/pacote-turno')
@UseGuards(PermissionGuard)
export class ShiftPackageController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ShiftPackageService) private readonly shiftPackageService: ShiftPackageService) {}

  @RequirePermission('COL.OPERAR')
  @Get()
  build(@Query() query: ShiftPackageQuery, @CurrentUser() principal: RequestPrincipal) {
    return this.shiftPackageService.build(query.warehouse_id, principal.userId);
  }
}
