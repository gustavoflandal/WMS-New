// DOC-02 §5.3 — product. Permissão DAD.PRODUCT_CATALOG_MANAGE
// (CLIENT_WAREHOUSE, DOC-12 migration 0016) — substitui o
// [LACUNA: RBAC DOC-12] da Sessão 2B.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ProductService, CreateProductInput, UpdateProductInput } from './product.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/products')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class ProductController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ProductService) private readonly productService: ProductService) {}

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Audited({ entity: 'product', action: 'CREATE', requirementId: 'DOC-02 §5.3' })
  @Post()
  create(@Body() body: CreateProductInput, @CurrentUser() principal: RequestPrincipal) {
    return this.productService.create(body, principal.userId);
  }

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Get()
  list(@Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal, @Query('sku') sku?: string) {
    if (sku) {
      return this.productService.findBySku(tenantId, principal.userId, sku);
    }
    return this.productService.listByTenant(tenantId, principal.userId);
  }

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.productService.findById(id, tenantId, principal.userId);
  }

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Query('tenant_id') tenantId: string,
    @Body() body: UpdateProductInput,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.productService.update(id, tenantId, body, principal.userId);
  }

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.productService.deactivate(id, tenantId, principal.userId);
  }
}
