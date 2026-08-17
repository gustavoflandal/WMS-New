// DOC-04 §4.5 — Motor de Putaway e execução de tarefas. Auditoria feita
// explicitamente dentro dos services (before/after reais) — nenhuma rota
// aqui usa @Audited()/AuditInterceptor para evitar registro duplicado.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PutawayEngineService } from './putaway-engine.service.js';
import { ExecutePutawayInput, PutawayTaskService } from './putaway-task.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface TenantWarehouseQuery {
  tenant_id: string;
  warehouse_id: string;
}

interface TenantWarehouseBody {
  tenant_id: string;
  warehouse_id: string;
}

interface AssignBody extends TenantWarehouseBody {
  assigned_to_user_id: string;
}

interface ExecuteBody extends TenantWarehouseBody {
  operation_id: string;
  scanned_lpn: string;
  scanned_location_code: string;
  override_reason?: string;
}

@Controller('recebimento/putaway')
@UseGuards(PermissionGuard)
export class PutawayController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(PutawayEngineService) private readonly putawayEngineService: PutawayEngineService,
    @Inject(PutawayTaskService) private readonly putawayTaskService: PutawayTaskService
  ) {}

  /** RN-REC-040: sugestão + 4 alternativas + diagnóstico das reprovações. */
  @RequirePermission('REC.EXECUTAR_PUTAWAY')
  @Get('pallets/:palletId/suggestion')
  suggest(@Param('palletId') palletId: string, @Query() query: TenantWarehouseQuery, @CurrentUser() principal: RequestPrincipal) {
    return this.putawayEngineService.suggestLocations(palletId, query.tenant_id, query.warehouse_id, principal.userId);
  }

  /** RF-REC-042: uma tarefa por palete da ordem (§5.1 LABELING -> PUTAWAY_IN_PROGRESS). */
  @RequirePermission('REC.EXECUTAR_PUTAWAY')
  @Post('inbound-orders/:orderId/generate-tasks')
  generateTasks(@Param('orderId') orderId: string, @Body() body: TenantWarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.putawayTaskService.generateTasksForOrder(orderId, body.tenant_id, body.warehouse_id, principal.userId);
  }

  /** RF-REC-042: fila por prioridade e proximidade. */
  @RequirePermission('REC.EXECUTAR_PUTAWAY')
  @Get('tasks')
  listQueue(@Query() query: TenantWarehouseQuery, @CurrentUser() principal: RequestPrincipal) {
    return this.putawayTaskService.listQueue(query.tenant_id, query.warehouse_id, principal.userId);
  }

  /** §5.2: CREATED -> ASSIGNED, já com o endereço designado pelo motor. */
  @RequirePermission('REC.EXECUTAR_PUTAWAY')
  @Post('tasks/:taskId/assign')
  assign(@Param('taskId') taskId: string, @Body() body: AssignBody, @CurrentUser() principal: RequestPrincipal) {
    return this.putawayTaskService.assignTask(taskId, body.assigned_to_user_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  /**
   * RF-REC-042: dupla leitura (LPN -> endereço) + confirmação idempotente.
   * A permissão declarada é a de EXECUÇÃO; o override (RN-REC-041) é checado
   * DENTRO do service contra EST.PUTAWAY_OVERRIDE, porque só é exigido
   * quando o endereço lido diverge do designado — declará-lo na rota
   * impediria a execução normal por quem não pode dar override.
   */
  @RequirePermission('REC.EXECUTAR_PUTAWAY')
  @Post('tasks/:taskId/execute')
  execute(@Param('taskId') taskId: string, @Body() body: ExecuteBody, @CurrentUser() principal: RequestPrincipal) {
    const input: ExecutePutawayInput = {
      operationId: body.operation_id,
      scannedLpn: body.scanned_lpn,
      scannedLocationCode: body.scanned_location_code,
      overrideReason: body.override_reason,
    };
    return this.putawayTaskService.executeTask(taskId, input, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
