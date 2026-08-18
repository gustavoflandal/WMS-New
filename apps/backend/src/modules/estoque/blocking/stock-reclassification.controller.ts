// DOC-05 §4.4 RF-EST-031 — Reclassificação para avaria e descarte.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { StockReclassificationService } from './stock-reclassification.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface AvariaBody extends TenantWarehouseBody {
  product_id: string;
  batch_id?: string;
  location_id?: string;
  pallet_id?: string;
  from_bucket: 'AVAILABLE' | 'BLOCKED';
  qty: number;
  photo_keys: string[];
}

interface DiscardRequestBody extends TenantWarehouseBody {
  product_id: string;
  batch_id?: string;
  location_id?: string;
  pallet_id?: string;
  source_bucket: 'DAMAGED' | 'BLOCKED';
  qty: number;
  reason_request: string;
}

interface DecideBody extends TenantWarehouseBody {
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}

@Controller('estoque')
@UseGuards(PermissionGuard)
export class StockReclassificationController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(StockReclassificationService) private readonly stockReclassificationService: StockReclassificationService) {}

  @RequirePermission('EST.DESCARTE')
  @Post('reclassificacoes/avaria')
  registerAvaria(@Body() body: AvariaBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockReclassificationService.registerAvaria({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      batchId: body.batch_id ?? null,
      locationId: body.location_id ?? null,
      palletId: body.pallet_id ?? null,
      fromBucket: body.from_bucket,
      qty: body.qty,
      photoKeys: body.photo_keys,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EST.DESCARTE')
  @Post('reclassificacoes/descarte')
  requestDiscard(@Body() body: DiscardRequestBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockReclassificationService.requestDiscard({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      batchId: body.batch_id ?? null,
      locationId: body.location_id ?? null,
      palletId: body.pallet_id ?? null,
      sourceBucket: body.source_bucket,
      qty: body.qty,
      reasonRequest: body.reason_request,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EST.DESCARTE')
  @Post('reclassificacoes/:id/decidir')
  decideDiscard(@Param('id') id: string, @Body() body: DecideBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockReclassificationService.decideDiscard(id, body.tenant_id, body.warehouse_id, principal.userId, body.decision, body.reason);
  }
}
