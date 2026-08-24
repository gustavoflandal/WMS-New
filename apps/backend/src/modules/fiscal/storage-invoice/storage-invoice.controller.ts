// DOC-08 §4.3 RF-FIS-020 — registro de Nota de Armazenagem (FIS.EMITIR).
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { RegisterStorageInvoiceInput, StorageInvoiceService } from './storage-invoice.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface RegisterStorageInvoiceBody {
  tenant_id: string;
  warehouse_id: string;
  issuer_cnpj: string;
  recipient_cnpj: string;
  issued_at: string;
  access_key?: string;
  total_value?: number;
  xml_storage_key?: string;
  items: Array<{ product_id: string; qty: number; reference_inbound_invoice_id: string }>;
}

@Controller('fiscal/notas-armazenagem')
@UseGuards(PermissionGuard)
export class StorageInvoiceController {
  constructor(@Inject(StorageInvoiceService) private readonly storageInvoiceService: StorageInvoiceService) {}

  @RequirePermission('FIS.EMITIR')
  @Post()
  register(@Body() body: RegisterStorageInvoiceBody, @CurrentUser() principal: RequestPrincipal) {
    const input: RegisterStorageInvoiceInput = {
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      issuerCnpj: body.issuer_cnpj,
      recipientCnpj: body.recipient_cnpj,
      issuedAt: body.issued_at,
      accessKey: body.access_key ?? null,
      totalValue: body.total_value ?? null,
      xmlStorageKey: body.xml_storage_key ?? null,
      items: body.items.map((i) => ({ productId: i.product_id, qty: i.qty, referenceInboundInvoiceId: i.reference_inbound_invoice_id })),
      actorUserId: principal.userId,
    };
    return this.storageInvoiceService.register(input);
  }
}
