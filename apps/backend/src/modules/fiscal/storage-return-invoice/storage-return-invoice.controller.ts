// DOC-08 §4.5 RN-FIS-040 — montagem da Nota de Devolução de Armazenagem
// (FIS.EMITIR). O caminho automático (pedido de expedição) é
// DispatchService.confirmFiscalDocuments (DOC-06); esta rota cobre emissão
// avulsa (fora de um pedido). Cancelamento/CCe: RNF-FIS-062 (Sessão 8B).
//
// A rota HTTP de "autorizar" manualmente (existente na 8A, substituto
// testável da SEFAZ) foi REMOVIDA nesta sessão — deixá-la exposta seria um
// bypass real do motor de emissão (assinatura/transmissão) uma vez que ele
// existe. `effectuateAuthorization()` agora só é chamado internamente por
// `FiscalEmissionService`, nunca via API. `assembleAndAuthorizeForOrder()`
// permanece como utilitário de TESTE, não exposto por rota.
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

interface CancelBody {
  tenant_id: string;
  warehouse_id: string;
  reason: string;
  exception_id: string;
}

interface CceBody {
  tenant_id: string;
  warehouse_id: string;
  correction_text: string;
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

  @RequirePermission('FIS.CANCELAR')
  @Post(':id/cancelar')
  cancel(@Param('id') id: string, @Body() body: CancelBody, @CurrentUser() principal: RequestPrincipal) {
    return this.storageReturnInvoiceService.cancel({
      fiscalDocumentId: id,
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      reason: body.reason,
      exceptionId: body.exception_id,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('FIS.CCE')
  @Post(':id/cce')
  registerCce(@Param('id') id: string, @Body() body: CceBody, @CurrentUser() principal: RequestPrincipal) {
    return this.storageReturnInvoiceService.registerCce(id, body.tenant_id, body.warehouse_id, body.correction_text, principal.userId);
  }
}
