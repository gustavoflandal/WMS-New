// DOC-06 §4.7 RF-EXP-061 (Carregamento) + RF-EXP-062 (Saída/Fim).
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { LoadingService } from './loading.service.js';
import { SaidaService } from './saida.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface OpenLoadingBody extends TenantWarehouseBody {
  vehicle_visit_id?: string;
  order_ids: string[];
}

interface ScanPackageBody extends TenantWarehouseBody {
  lpn: string;
}

@Controller('expedicao')
@UseGuards(PermissionGuard)
export class LoadingController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(LoadingService) private readonly loadingService: LoadingService,
    @Inject(SaidaService) private readonly saidaService: SaidaService
  ) {}

  @RequirePermission('EXP.CARREGAMENTO_EXECUTAR')
  @Post('cargas')
  open(@Body() body: OpenLoadingBody, @CurrentUser() principal: RequestPrincipal) {
    return this.loadingService.openLoading({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      vehicleVisitId: body.vehicle_visit_id ?? null,
      orderIds: body.order_ids,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('EXP.CARREGAMENTO_EXECUTAR')
  @Post('cargas/:id/ler-volume')
  scan(@Param('id') id: string, @Body() body: ScanPackageBody, @CurrentUser() principal: RequestPrincipal) {
    return this.loadingService.scanPackage(id, body.lpn, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('EXP.CARREGAMENTO_EXECUTAR')
  @Post('pedidos/:id/saida/concluir')
  completeExit(@Param('id') id: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.saidaService.completeExit(id, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
