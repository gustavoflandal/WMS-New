// DOC-08 §4.1 RN-FIS-001 — troca de modo fiscal (FIS.CONFIG).
import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { FiscalModeService } from './fiscal-mode.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface ChangeFiscalModeBody {
  tenant_id: string;
  warehouse_id: string;
  fiscal_mode: string;
}

@Controller('fiscal/modo')
@UseGuards(PermissionGuard)
export class FiscalModeController {
  constructor(@Inject(FiscalModeService) private readonly fiscalModeService: FiscalModeService) {}

  @RequirePermission('FIS.CONFIG')
  @Get()
  get(@Query('tenant_id') tenantId: string, @Query('warehouse_id') warehouseId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.fiscalModeService.getFiscalMode(tenantId, warehouseId, principal.userId);
  }

  @RequirePermission('FIS.CONFIG')
  @Post()
  change(@Body() body: ChangeFiscalModeBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fiscalModeService.changeFiscalMode(body.tenant_id, body.warehouse_id, body.fiscal_mode, principal.userId);
  }
}
