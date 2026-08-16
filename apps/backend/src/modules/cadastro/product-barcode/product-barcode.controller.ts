// DOC-02 §5.3 — product_barcode. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ProductBarcodeService, CreateProductBarcodeInput } from './product-barcode.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/product-barcodes')
@UseGuards(NoAuthGuard)
export class ProductBarcodeController {
  constructor(private readonly service: ProductBarcodeService) {}

  @Post()
  create(@Body() body: CreateProductBarcodeInput) {
    return this.service.create(body);
  }

  @Get()
  list(
    @Query('tenant_id') tenantId: string,
    @Query('actor_user_id') actorUserId: string,
    @Query('product_id') productId?: string,
    @Query('barcode') barcode?: string
  ) {
    if (barcode) {
      return this.service.findByBarcode(tenantId, actorUserId, barcode);
    }
    return this.service.listByProduct(tenantId, actorUserId, productId as string);
  }
}
