// DOC-02 §5.4 — batch. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { BatchService, CreateBatchInput, UpdateBatchInput } from './batch.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/batches')
@UseGuards(NoAuthGuard)
export class BatchController {
  constructor(private readonly batchService: BatchService) {}

  @Post()
  create(@Body() body: CreateBatchInput) {
    return this.batchService.create(body);
  }

  @Get()
  list(
    @Query('tenant_id') tenantId: string,
    @Query('actor_user_id') actorUserId: string,
    @Query('product_id') productId: string,
    @Query('batch_code') batchCode?: string
  ) {
    if (batchCode) {
      return this.batchService.findByCode(tenantId, actorUserId, productId, batchCode);
    }
    return this.batchService.listByProduct(tenantId, actorUserId, productId);
  }

  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string) {
    return this.batchService.findById(id, tenantId, actorUserId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Body() body: UpdateBatchInput) {
    return this.batchService.update(id, tenantId, body);
  }
}
