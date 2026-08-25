// DOC-17 §6 — RN-TEL-010 (Modo de Execução). Consulta e configuração.
// A EXECUÇÃO em si continua nas rotas de cada módulo (RN-TEL-011): este
// controller não executa operação nenhuma, só governa o modo.
import { BadRequestException, Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { ExecutionModeService } from './execution-mode.service.js';

interface TenantWarehouseQuery {
  tenant_id: string;
  warehouse_id: string;
  operation?: string;
}

interface SetModeBody {
  tenant_id: string;
  warehouse_id: string;
  mode: string;
  /** RN-TEL-010: "e, opcionalmente, por tipo de operação". */
  operation?: string;
}

@Controller('modo-execucao')
@UseGuards(PermissionGuard)
export class ExecutionModeController {
  constructor(@Inject(ExecutionModeService) private readonly executionModeService: ExecutionModeService) {}

  /** Consulta — a tela precisa saber, ao abrir, se pode executar neste armazém. */
  @RequirePermission('TEL.EXECUCAO_TELA')
  @Get()
  async getMode(@Query() query: TenantWarehouseQuery, @CurrentUser() principal: RequestPrincipal) {
    if (!query.warehouse_id) throw new BadRequestException({ error: 'WAREHOUSE_ID_REQUIRED', detail: 'warehouse_id é obrigatório' });
    const mode = await this.executionModeService.resolveMode(
      { tenant_id: query.tenant_id, user_id: principal.userId, warehouse_id: query.warehouse_id },
      query.operation
    );
    return { mode, operation: query.operation ?? null };
  }

  /** RN-TEL-010 — configuração do modo (sensível: muda como o armazém inteiro opera). */
  @RequirePermission('TEL.MODO_EXECUCAO_CONFIGURAR')
  @Post()
  setMode(@Body() body: SetModeBody, @CurrentUser() principal: RequestPrincipal) {
    if (!body.warehouse_id) throw new BadRequestException({ error: 'WAREHOUSE_ID_REQUIRED', detail: 'warehouse_id é obrigatório' });
    return this.executionModeService.setMode(
      { tenant_id: body.tenant_id, user_id: principal.userId, warehouse_id: body.warehouse_id },
      body.mode,
      body.operation ?? null,
      principal.userId
    );
  }
}
