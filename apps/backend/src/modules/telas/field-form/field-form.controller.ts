// DOC-17 §7 — Formulário de Campo. Auditoria feita dentro do service
// (before/after reais) — mesmo padrão de putaway.controller.ts.
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { FieldFormService } from './field-form.service.js';

interface TenantWarehouseQuery {
  tenant_id: string;
  warehouse_id: string;
}

interface EmitPutawayBody extends TenantWarehouseQuery {
  task_ids: string[];
  declared_executor_name: string;
  declared_executor_registration?: string;
}

interface ReasonBody extends TenantWarehouseQuery {
  reason: string;
}

@Controller('formularios-campo')
@UseGuards(PermissionGuard)
export class FieldFormController {
  constructor(
    @Inject(FieldFormService) private readonly fieldFormService: FieldFormService,
    @Inject(FileStorageService) private readonly fileStorageService: FileStorageService
  ) {}

  /** RF-TEL-020/RN-TEL-021 — só Putaway (T-P1) tem hook de reserva real nesta sessão (ver prompt §1). */
  @RequirePermission('TEL.FORMULARIO_EMITIR')
  @Post('putaway')
  emitPutaway(@Body() body: EmitPutawayBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fieldFormService.emitPutawayForm(
      {
        tenantId: body.tenant_id,
        warehouseId: body.warehouse_id,
        taskIds: body.task_ids,
        declaredExecutorName: body.declared_executor_name,
        declaredExecutorRegistration: body.declared_executor_registration,
      },
      principal.userId
    );
  }

  @RequirePermission('TEL.FORMULARIO_CANCELAR')
  @Post(':id/cancelar')
  cancel(@Param('id') id: string, @Body() body: ReasonBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fieldFormService.cancel({ tenantId: body.tenant_id, warehouseId: body.warehouse_id, formId: id, reason: body.reason }, principal.userId);
  }

  @RequirePermission('TEL.FORMULARIO_REEMITIR')
  @Post(':id/reemitir')
  reissue(@Param('id') id: string, @Body() body: ReasonBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fieldFormService.reissue({ tenantId: body.tenant_id, warehouseId: body.warehouse_id, formId: id, reason: body.reason }, principal.userId);
  }

  @RequirePermission('TEL.FORMULARIO_EMITIR')
  @Get(':id')
  getForm(@Param('id') id: string, @Query() query: TenantWarehouseQuery, @CurrentUser() principal: RequestPrincipal) {
    return this.fieldFormService.getForm(query.tenant_id, query.warehouse_id, id, principal.userId);
  }

  /** RF-TEL-020: entrega só por download nesta sessão (ver decisão 5 do prompt) — sem PRINT_PDF do Edge Agent ainda. */
  @RequirePermission('TEL.FORMULARIO_EMITIR')
  @Get(':id/pdf')
  async downloadPdf(@Param('id') id: string, @Query() query: TenantWarehouseQuery, @CurrentUser() principal: RequestPrincipal, @Res() res: Response) {
    if (!query.warehouse_id) throw new BadRequestException({ error: 'WAREHOUSE_ID_REQUIRED', detail: 'warehouse_id é obrigatório' });
    const key = await this.fieldFormService.getPdfStorageKey(query.tenant_id, query.warehouse_id, id, principal.userId);
    const buffer = await this.fileStorageService.download(key);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="formulario-${id}.pdf"`);
    res.send(buffer);
  }
}
