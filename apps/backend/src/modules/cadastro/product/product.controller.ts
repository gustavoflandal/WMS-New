// DOC-02 §5.3 — product. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ProductService, CreateProductInput, UpdateProductInput } from './product.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/products')
@UseGuards(NoAuthGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  create(@Body() body: CreateProductInput) {
    return this.productService.create(body);
  }

  @Get()
  list(@Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string, @Query('sku') sku?: string) {
    if (sku) {
      return this.productService.findBySku(tenantId, actorUserId, sku);
    }
    return this.productService.listByTenant(tenantId, actorUserId);
  }

  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Query('actor_user_id') actorUserId: string) {
    return this.productService.findById(id, tenantId, actorUserId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Body() body: UpdateProductInput) {
    return this.productService.update(id, tenantId, body);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Query('tenant_id') tenantId: string, @Body('actor_user_id') actorUserId: string) {
    return this.productService.deactivate(id, tenantId, actorUserId);
  }
}
