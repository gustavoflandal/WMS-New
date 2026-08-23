// DOC-05 §4.6 — RF-EST-050 (transferência interna) + RF-EST-051 (transferência entre armazéns).
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { StockTransferService } from './stock-transfer.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TransferInternalBody {
  tenant_id: string;
  warehouse_id: string;
  product_id: string;
  batch_id?: string;
  qty: number;
  location_id_origin: string;
  pallet_id_origin?: string;
  location_id_destination: string;
  pallet_id_destination?: string;
  override_reason?: string;
  /** RNF-ARQ-050/RG-009: opcional — presente quando a chamada vem da fila offline do coletor (DOC-15 T6). */
  operation_id?: string;
}

interface TransferInterwarehouseBody {
  tenant_id: string;
  warehouse_id_origin: string;
  warehouse_id_destination: string;
  items: Array<{ product_id: string; batch_id?: string; qty: number; location_id_origin: string; pallet_id_origin?: string }>;
}

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface CompleteReceivingBody extends TenantWarehouseBody {
  items: Array<{ item_id: string; location_id_destination: string; pallet_id_destination?: string; override_reason?: string }>;
}

@Controller('estoque/transferencias')
@UseGuards(PermissionGuard)
export class StockTransferController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(StockTransferService) private readonly stockTransferService: StockTransferService) {}

  @RequirePermission('EST.TRANSFERIR_INTERNO')
  @Post('interna')
  transferInternal(@Body() body: TransferInternalBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.transferInternal({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      batchId: body.batch_id ?? null,
      qty: body.qty,
      locationIdOrigin: body.location_id_origin,
      palletIdOrigin: body.pallet_id_origin ?? null,
      locationIdDestination: body.location_id_destination,
      palletIdDestination: body.pallet_id_destination ?? null,
      overrideReason: body.override_reason,
      actorUserId: principal.userId,
      operationId: body.operation_id,
    });
  }

  @RequirePermission('EST.TRANSFERIR_ARMAZEM')
  @Post('interarmazem')
  createInterwarehouse(@Body() body: TransferInterwarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.createInterwarehouse({
      tenantId: body.tenant_id,
      warehouseIdOrigin: body.warehouse_id_origin,
      warehouseIdDestination: body.warehouse_id_destination,
      items: body.items.map((i) => ({ productId: i.product_id, batchId: i.batch_id ?? null, qty: i.qty, locationIdOrigin: i.location_id_origin, palletIdOrigin: i.pallet_id_origin ?? null })),
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EST.TRANSFERIR_ARMAZEM')
  @Post(':id/picking/iniciar')
  startPicking(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.startPicking(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EST.TRANSFERIR_ARMAZEM')
  @Post(':id/picking/concluir')
  completePicking(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.completePicking(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EST.TRANSFERIR_ARMAZEM')
  @Post(':id/recebimento/iniciar')
  startReceiving(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.startReceiving(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EST.TRANSFERIR_ARMAZEM')
  @Post(':id/recebimento/concluir')
  completeReceiving(@Param('id') id: string, @Body() body: CompleteReceivingBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.completeReceiving(
      id,
      body.items.map((i) => ({ itemId: i.item_id, locationIdDestination: i.location_id_destination, palletIdDestination: i.pallet_id_destination ?? null, overrideReason: i.override_reason })),
      body.tenant_id,
      body.warehouse_id,
      principal.userId
    );
  }

  @RequirePermission('EST.TRANSFERIR_ARMAZEM')
  @Post(':id/cancelar')
  cancel(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.stockTransferService.cancel(id, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
