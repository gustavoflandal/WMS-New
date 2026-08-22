// DOC-05 §4.7 — rotas HTTP do Inventário. Convenção `estoque/<domínio-plural>`
// (estoque/transferencias, estoque/reservas, estoque/bloqueios).
//
// [LACUNA: DOC-05 §3 não nomeia permissão de LEITURA/consulta de um
// inventário — só PLANEJAR/CONTAR/APROVAR_AJUSTE. Mesma disciplina de
// stock-reservation.controller.ts (RN-EST-013): não inventa código de
// permissão para expor uma rota de detalhe/consulta; esta sessão só expõe os
// 5 atos que o catálogo nomeia.]
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { InventoryPlanningService, CountType } from './inventory-planning.service.js';
import { InventoryCountExecutionService } from './inventory-count-execution.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface PlanInventoryBody {
  tenant_id: string;
  warehouse_id: string;
  count_type: CountType;
  product_ids?: string[];
  zone_ids?: string[];
  species?: string[];
  location_ids?: string[];
  sample_size?: number;
  random_seed?: string;
  include_empty?: boolean;
}

interface WarehouseScopedBody {
  tenant_id: string;
  warehouse_id: string;
}

interface SubmitRoundBody extends WarehouseScopedBody {
  counted_qty: number;
  unit_cost_brl?: number;
  reason_request?: string;
}

interface DecideAdjustmentBody extends WarehouseScopedBody {
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}

@Controller('estoque/inventarios')
@UseGuards(PermissionGuard)
export class InventoryCountController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(InventoryPlanningService) private readonly inventoryPlanningService: InventoryPlanningService,
    @Inject(InventoryCountExecutionService) private readonly inventoryCountExecutionService: InventoryCountExecutionService
  ) {}

  /** RF-EST-060 — planeja o escopo (não congela nada ainda, §5.1 PLANNED). */
  @RequirePermission('EST.INVENTARIO_PLANEJAR')
  @Post()
  plan(@Body() body: PlanInventoryBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inventoryPlanningService.plan({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      countType: body.count_type,
      productIds: body.product_ids,
      zoneIds: body.zone_ids,
      species: body.species,
      locationIds: body.location_ids,
      sampleSize: body.sample_size,
      randomSeed: body.random_seed,
      includeEmpty: body.include_empty,
      actorUserId: principal.userId,
    });
  }

  /** RN-EST-061 [INVIOLÁVEL] — PLANNED -> IN_PROGRESS, congela os endereços do escopo. */
  @RequirePermission('EST.INVENTARIO_PLANEJAR')
  @Post(':id/iniciar')
  start(@Param('id') id: string, @Body() body: WarehouseScopedBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inventoryPlanningService.start(body.tenant_id, body.warehouse_id, id, principal.userId);
  }

  /** §5.1 — PLANNED -> CANCELLED (antes de iniciar). */
  @RequirePermission('EST.INVENTARIO_PLANEJAR')
  @Post(':id/cancelar')
  cancel(@Param('id') id: string, @Body() body: WarehouseScopedBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inventoryPlanningService.cancel(body.tenant_id, body.warehouse_id, id, principal.userId);
  }

  /** RN-EST-062 [INVIOLÁVEL] — registra uma rodada de contagem (1ª/2ª/3ª conforme o estado da célula). */
  @RequirePermission('EST.INVENTARIO_CONTAR')
  @Post('celulas/:id/contagens')
  submitRound(@Param('id') id: string, @Body() body: SubmitRoundBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inventoryCountExecutionService.submitRound({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      countLocationId: id,
      countedQty: body.counted_qty,
      unitCostBrl: body.unit_cost_brl,
      reasonRequest: body.reason_request,
      actorUserId: principal.userId,
    });
  }

  /** RN-EST-063 — decide a exceção EST.AJUSTE_INVENTARIO e aplica o efeito (ajuste de saldo ou nova rodada). */
  @RequirePermission('EST.INVENTARIO_APROVAR_AJUSTE')
  @Post('ajustes/:exceptionId/decidir')
  decideAdjustment(@Param('exceptionId') exceptionId: string, @Body() body: DecideAdjustmentBody, @CurrentUser() principal: RequestPrincipal) {
    return this.inventoryCountExecutionService.decideAdjustment({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      exceptionId,
      decision: body.decision,
      reason: body.reason,
      actorUserId: principal.userId,
    });
  }
}
