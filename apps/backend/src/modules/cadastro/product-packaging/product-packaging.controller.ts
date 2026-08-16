// DOC-02 §5.3 — product_packaging. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ProductPackagingService, CreateProductPackagingInput } from './product-packaging.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/product-packaging')
@UseGuards(NoAuthGuard)
export class ProductPackagingController {
  constructor(private readonly service: ProductPackagingService) {}

  @Post()
  create(@Body() body: CreateProductPackagingInput) {
    return this.service.create(body);
  }

  @Get()
  listByProduct(@Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string, @Query('product_id') productId: string) {
    return this.service.listByProduct(tenantId, actorUserId, productId);
  }

  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string) {
    return this.service.findById(id, tenantId, actorUserId);
  }
}
