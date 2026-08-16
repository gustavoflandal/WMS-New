// DOC-02 §5.3 — product_barcode. Permissão DAD.PRODUCT_CATALOG_MANAGE
// (CLIENT_WAREHOUSE, DOC-12 migration 0016) — substitui o
// [LACUNA: RBAC DOC-12] da Sessão 2B.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ProductBarcodeService, CreateProductBarcodeInput } from './product-barcode.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/product-barcodes')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class ProductBarcodeController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ProductBarcodeService) private readonly service: ProductBarcodeService) {}

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Audited({ entity: 'product_barcode', action: 'CREATE', requirementId: 'DOC-02 §5.3' })
  @Post()
  create(@Body() body: CreateProductBarcodeInput, @CurrentUser() principal: RequestPrincipal) {
    return this.service.create(body, principal.userId);
  }

  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  @Get()
  list(
    @Query('tenant_id') tenantId: string,
    @CurrentUser() principal: RequestPrincipal,
    @Query('product_id') productId?: string,
    @Query('barcode') barcode?: string
  ) {
    if (barcode) {
      return this.service.findByBarcode(tenantId, principal.userId, barcode);
    }
    return this.service.listByProduct(tenantId, principal.userId, productId as string);
  }
}
