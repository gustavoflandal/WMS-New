// DOC-05 §4.4 RF-EST-030 — Bloqueio/desbloqueio manual de saldo.
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { StockBlockService } from './stock-block.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface BlockBody {
  tenant_id: string;
  warehouse_id: string;
  product_id: string;
  batch_id?: string;
  location_id?: string;
  pallet_id?: string;
  qty: number;
  reason_code: string;
  reason_text?: string;
}

@Controller('estoque')
@UseGuards(PermissionGuard)
export class StockBlockController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(StockBlockService) private readonly stockBlockService: StockBlockService) {}

  @RequirePermission('EST.BLOQUEAR_SALDO')
  @Post('bloqueios')
  block(@Body() body: BlockBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockBlockService.block({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      batchId: body.batch_id ?? null,
      locationId: body.location_id ?? null,
      palletId: body.pallet_id ?? null,
      qty: body.qty,
      reasonCode: body.reason_code,
      reasonText: body.reason_text ?? null,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EST.DESBLOQUEAR_SALDO')
  @Post('desbloqueios')
  unblock(@Body() body: BlockBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockBlockService.unblock({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      batchId: body.batch_id ?? null,
      locationId: body.location_id ?? null,
      palletId: body.pallet_id ?? null,
      qty: body.qty,
      reasonCode: body.reason_code,
      reasonText: body.reason_text ?? null,
      actorUserId: principal.userId,
    });
  }
}
