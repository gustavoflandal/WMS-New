// DOC-17 §8 — Transcrição de Formulário de Campo. Auditoria dentro do
// service (before/after reais) — mesmo padrão de putaway.controller.ts.
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { TranscriptionService, TranscribedLineInput } from './transcription.service.js';

interface TenantWarehouseQuery {
  tenant_id: string;
  warehouse_id: string;
}

interface TranscribeBody extends TenantWarehouseQuery {
  lines: TranscribedLineInput[];
  segregation_exception_id?: string;
  expiry_exception_id?: string;
}

@Controller('transcricoes')
@UseGuards(PermissionGuard)
export class TranscriptionController {
  constructor(@Inject(TranscriptionService) private readonly transcriptionService: TranscriptionService) {}

  /**
   * RF-TEL-030 — localiza o formulário pelo NÚMERO (o que o digitador lê do
   * papel, ou do código de barras Code 128 impresso — RF-TEL-020).
   */
  @RequirePermission('TEL.TRANSCREVER')
  @Get('formularios/:number')
  findForm(@Param('number') number: string, @Query() query: TenantWarehouseQuery, @CurrentUser() principal: RequestPrincipal) {
    if (!query.warehouse_id) throw new BadRequestException({ error: 'WAREHOUSE_ID_REQUIRED', detail: 'warehouse_id é obrigatório' });
    return this.transcriptionService.findByNumber(number, query.tenant_id, query.warehouse_id, principal.userId);
  }

  /**
   * RF-TEL-030 — efetiva a transcrição. Reenvio devolve o resultado ORIGINAL
   * sem efeito adicional (RN-TEL-031 item 2), então é seguro repetir.
   *
   * A permissão declarada é a de transcrever; a dispensa de segregação
   * (TEL.TRANSCREVER_PROPRIO) é verificada DENTRO do service, porque só é
   * exigida quando o transcritor é o próprio executante — declará-la na rota
   * impediria a transcrição normal de quem não a possui.
   */
  @RequirePermission('TEL.TRANSCREVER')
  @Post('formularios/:fieldFormId')
  transcribe(@Param('fieldFormId') fieldFormId: string, @Body() body: TranscribeBody, @CurrentUser() principal: RequestPrincipal) {
    return this.transcriptionService.transcribe(
      {
        tenantId: body.tenant_id,
        warehouseId: body.warehouse_id,
        fieldFormId,
        lines: body.lines ?? [],
        segregationExceptionId: body.segregation_exception_id ?? null,
        expiryExceptionId: body.expiry_exception_id ?? null,
      },
      principal.userId
    );
  }
}
