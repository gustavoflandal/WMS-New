// DOC-08 §4.5 RN-FIS-040 — montagem/autorização manual da Nota de Devolução
// de Armazenagem (FIS.EMITIR). O caminho automático (pedido de expedição)
// é DispatchService.confirmFiscalDocuments (DOC-06); estas rotas cobrem
// emissão avulsa (fora de um pedido) e o passo de "autorização" explícito.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { StorageReturnInvoiceService } from './storage-return-invoice.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface AssembleBody {
  tenant_id: string;
  warehouse_id: string;
  outbound_order_id?: string;
  manual_exception_id?: string;
  items: Array<{ product_id: string; qty: number; manual_fiscal_document_ids?: string[] }>;
}

interface AuthorizeBody {
  tenant_id: string;
  warehouse_id: string;
}

@Controller('fiscal/notas-devolucao')
@UseGuards(PermissionGuard)
export class StorageReturnInvoiceController {
  constructor(@Inject(StorageReturnInvoiceService) private readonly storageReturnInvoiceService: StorageReturnInvoiceService) {}

  @RequirePermission('FIS.EMITIR')
  @Post()
  assemble(@Body() body: AssembleBody, @CurrentUser() principal: RequestPrincipal) {
    return this.storageReturnInvoiceService.assemble({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      outboundOrderId: body.outbound_order_id ?? null,
      manualExceptionId: body.manual_exception_id ?? null,
      items: body.items.map((i) => ({ productId: i.product_id, qty: i.qty, manualFiscalDocumentIds: i.manual_fiscal_document_ids })),
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('FIS.EMITIR')
  @Post(':id/autorizar')
  authorize(@Param('id') id: string, @Body() body: AuthorizeBody, @CurrentUser() principal: RequestPrincipal) {
    return this.storageReturnInvoiceService.authorize(id, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
