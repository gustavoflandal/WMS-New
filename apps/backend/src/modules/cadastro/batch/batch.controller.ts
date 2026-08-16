// DOC-02 §5.4 — batch. Permissão DAD.BATCH_MANAGE (CLIENT_WAREHOUSE,
// DOC-12 migration 0016) — substitui o [LACUNA: RBAC DOC-12] da Sessão 2B.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { BatchService, CreateBatchInput, UpdateBatchInput } from './batch.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/batches')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class BatchController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(BatchService) private readonly batchService: BatchService) {}

  @RequirePermission('DAD.BATCH_MANAGE')
  @Audited({ entity: 'batch', action: 'CREATE', requirementId: 'DOC-02 §5.4' })
  @Post()
  create(@Body() body: CreateBatchInput, @CurrentUser() principal: RequestPrincipal) {
    return this.batchService.create(body, principal.userId);
  }

  @RequirePermission('DAD.BATCH_MANAGE')
  @Get()
  list(
    @Query('tenant_id') tenantId: string,
    @Query('product_id') productId: string,
    @CurrentUser() principal: RequestPrincipal,
    @Query('batch_code') batchCode?: string
  ) {
    if (batchCode) {
      return this.batchService.findByCode(tenantId, principal.userId, productId, batchCode);
    }
    return this.batchService.listByProduct(tenantId, principal.userId, productId);
  }

  @RequirePermission('DAD.BATCH_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.batchService.findById(id, tenantId, principal.userId);
  }

  @RequirePermission('DAD.BATCH_MANAGE')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Body() body: UpdateBatchInput,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.batchService.update(id, tenantId, body, principal.userId);
  }
}
