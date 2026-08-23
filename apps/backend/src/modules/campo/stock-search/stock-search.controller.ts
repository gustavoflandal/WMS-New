// DOC-15 §4.5 T7 (Consulta).
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { StockSearchService } from './stock-search.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import type { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';

@Controller('campo/consulta')
@UseGuards(PermissionGuard)
export class StockSearchController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(StockSearchService) private readonly stockSearchService: StockSearchService) {}

  @RequirePermission('COL.CONSULTA_SALDO')
  @Get()
  search(
    @Query('codigo') codigo: string,
    @Query('tenant_id') tenantId: string,
    @Query('warehouse_id') warehouseId: string,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.stockSearchService.search(codigo, tenantId, warehouseId, principal.userId);
  }
}
