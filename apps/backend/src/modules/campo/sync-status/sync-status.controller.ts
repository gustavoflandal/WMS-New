// DOC-15 §4.5 T8 (Sincronização).
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { SyncStatusService } from './sync-status.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';

@Controller('campo/sincronizacao')
@UseGuards(PermissionGuard)
export class SyncStatusController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(SyncStatusService) private readonly syncStatusService: SyncStatusService) {}

  // warehouse_id não é usado pela consulta (device_id já é a chave), mas é
  // exigido na query para o PermissionGuard resolver o escopo WAREHOUSE de
  // COL.OPERAR (achado real na Sessão 7B: RN-SEG-011 exige a dimensão
  // presente na requisição, não só na regra de negócio).
  @RequirePermission('COL.OPERAR')
  @Get()
  status(@Query('device_id') deviceId: string, @Query('warehouse_id') _warehouseId: string) {
    return this.syncStatusService.getStatus(deviceId);
  }
}
