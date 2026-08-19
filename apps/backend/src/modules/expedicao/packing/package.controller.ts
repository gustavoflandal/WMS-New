// DOC-06 §4.5/§4.6 — Packing (Volumação) e Pesagem.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { PackageService } from './package.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface OpenPackageBody extends TenantWarehouseBody {
  outbound_order_id: string;
  package_type_code: string;
}

interface DeclareContentBody extends TenantWarehouseBody {
  product_id: string;
  batch_id?: string;
  qty: number;
}

interface WeighBody extends TenantWarehouseBody {
  weight_kg: number;
  source: 'SCALE' | 'MANUAL';
  reason_text?: string;
}

interface WeightDecisionBody extends TenantWarehouseBody {
  decision: 'ACCEPT' | 'RETURN_TO_PACKING';
  reason: string;
}

interface CompletePackingBody extends TenantWarehouseBody {}

@Controller('expedicao')
@UseGuards(PermissionGuard)
export class PackageController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(PackageService) private readonly packageService: PackageService) {}

  @RequirePermission('EXP.PACKING_EXECUTAR')
  @Post('volumes')
  open(@Body() body: OpenPackageBody, @CurrentUser() principal: RequestPrincipal) {
    return this.packageService.openPackage({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      outboundOrderId: body.outbound_order_id,
      packageTypeCode: body.package_type_code,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.PACKING_EXECUTAR')
  @Post('volumes/:id/conteudo')
  declareContent(@Param('id') id: string, @Body() body: DeclareContentBody, @CurrentUser() principal: RequestPrincipal) {
    return this.packageService.declareContent({
      packageId: id,
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      productId: body.product_id,
      batchId: body.batch_id ?? null,
      qty: body.qty,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.PACKING_EXECUTAR')
  @Post('volumes/:id/fechar')
  close(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.packageService.closePackage(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EXP.PACKING_EXECUTAR')
  @Post('pedidos/:id/embalagem/concluir')
  completePacking(@Param('id') id: string, @Body() body: CompletePackingBody, @CurrentUser() principal: RequestPrincipal) {
    return this.packageService.attemptCompletePackingStep(id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EXP.PESAGEM_EXECUTAR')
  @Post('volumes/:id/pesar')
  weigh(@Param('id') id: string, @Body() body: WeighBody, @CurrentUser() principal: RequestPrincipal) {
    return this.packageService.weighPackage({
      packageId: id,
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      weightKg: body.weight_kg,
      source: body.source,
      reasonText: body.reason_text ?? null,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.ONDA_GERIR')
  @Post('volumes/:id/decisao-peso')
  decideWeight(@Param('id') id: string, @Body() body: WeightDecisionBody, @CurrentUser() principal: RequestPrincipal) {
    return this.packageService.decideWeightDivergence(id, body.decision, body.reason, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
