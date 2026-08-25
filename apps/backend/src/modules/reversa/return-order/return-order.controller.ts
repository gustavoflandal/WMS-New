// DOC-07 §4.1-§4.3 — Ordem de Devolução, chegada/doca/descarga, Triagem e
// Destinação. Este controller só transporta — as guardas (máquina de
// estados, matriz de destinação, gancho fiscal) vivem nos services.
import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { ReturnOrderService, ReturnOrderType } from './return-order.service.js';
import { ReturnTriageService } from '../triage/return-triage.service.js';
import { Disposition, PhysicalState } from '../triage/disposition-matrix.util.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface CreateReturnOrderBody extends TenantWarehouseBody {
  type: ReturnOrderType;
  source_outbound_order_id?: string;
  items: Array<{ product_id: string; qty: number; source_outbound_order_item_id?: string; approved_exception_id?: string }>;
}

interface DenyOrCancelBody extends TenantWarehouseBody {
  reason: string;
}

interface LinkArrivalBody extends TenantWarehouseBody {
  vehicle_visit_id: string;
}

interface AssignDockBody extends TenantWarehouseBody {
  dock_id: string;
}

interface RegisterTriageBody extends TenantWarehouseBody {
  return_order_item_id: string;
  product_id: string;
  qty: number;
  physical_state: PhysicalState;
  batch_code?: string;
  photo_keys?: string[];
}

interface ConfirmDispositionBody extends TenantWarehouseBody {
  confirmed_disposition: Disposition;
  client_decision?: boolean;
}

@Controller('reversa/ordens')
@UseGuards(PermissionGuard)
export class ReturnOrderController {
  constructor(
    @Inject(ReturnOrderService) private readonly returnOrderService: ReturnOrderService,
    @Inject(ReturnTriageService) private readonly returnTriageService: ReturnTriageService
  ) {}

  @RequirePermission('REV.AUTORIZAR')
  @Post()
  create(@Body() body: CreateReturnOrderBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.createReturnOrder(
      {
        tenantId: body.tenant_id,
        warehouseId: body.warehouse_id,
        type: body.type,
        sourceOutboundOrderId: body.source_outbound_order_id ?? null,
        items: body.items.map((i) => ({
          productId: i.product_id,
          qty: i.qty,
          sourceOutboundOrderItemId: i.source_outbound_order_item_id ?? null,
          approvedExceptionId: i.approved_exception_id ?? null,
        })),
      },
      principal.userId
    );
  }

  @RequirePermission('REV.AUTORIZAR')
  @Get(':id')
  findById(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.findById(id, body.tenant_id, principal.userId);
  }

  @RequirePermission('REV.AUTORIZAR')
  @Post(':id/autorizar')
  authorize(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.authorize(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REV.AUTORIZAR')
  @Post(':id/negar')
  deny(@Param('id') id: string, @Body() body: DenyOrCancelBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.deny(id, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }

  @RequirePermission('REV.AUTORIZAR')
  @Post(':id/cancelar')
  cancel(@Param('id') id: string, @Body() body: DenyOrCancelBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.cancel(id, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }

  @RequirePermission('REV.TRIAGEM')
  @Post(':id/chegada')
  linkArrival(@Param('id') id: string, @Body() body: LinkArrivalBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.linkArrival(id, body.vehicle_visit_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REV.TRIAGEM')
  @Post(':id/doca')
  assignDock(@Param('id') id: string, @Body() body: AssignDockBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.assignDock(id, body.dock_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REV.TRIAGEM')
  @Post(':id/descarga')
  completeUnloading(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnOrderService.completeUnloading(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REV.TRIAGEM')
  @Post(':id/triagem')
  registerTriage(@Param('id') id: string, @Body() body: RegisterTriageBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnTriageService.registerTriage(
      {
        tenantId: body.tenant_id,
        warehouseId: body.warehouse_id,
        returnOrderId: id,
        returnOrderItemId: body.return_order_item_id,
        productId: body.product_id,
        qty: body.qty,
        physicalState: body.physical_state,
        batchCode: body.batch_code ?? null,
        photoKeys: body.photo_keys ?? [],
      },
      principal.userId
    );
  }

  @RequirePermission('REV.TRIAGEM')
  @Post(':id/triagem/concluir')
  completeTriage(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnTriageService.completeTriage(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('REV.DESTINACAO')
  @Post('triagem/:triageRecordId/destinacao')
  confirmDisposition(@Param('triageRecordId') triageRecordId: string, @Body() body: ConfirmDispositionBody, @CurrentUser() principal: RequestPrincipal) {
    return this.returnTriageService.confirmDisposition(
      {
        tenantId: body.tenant_id,
        warehouseId: body.warehouse_id,
        triageRecordId,
        confirmedDisposition: body.confirmed_disposition,
        clientDecision: body.client_decision ?? false,
      },
      principal.userId
    );
  }
}
