// DOC-11 RN-PER-020/RF-PER-021 — ciclo de vida de label_template (edição,
// impressão de teste, aprovação, ativação) e reimpressão de etiqueta.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { LabelTemplateService } from './label-template.service.js';
import { PeripheralJobService } from '../jobs/peripheral-job.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import type { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';

interface CreateDraftBody {
  warehouse_id: string; // só rastreabilidade de audit_log (RD-SEG-030) — PER.GESTAO_TEMPLATES é GLOBAL, não restringe por armazém.
  code: 'LPN_PALETE' | 'LPN_VOLUME' | 'ENDERECO' | 'LOTE_INTERNO' | 'CONTEUDO_PALETE';
  format: 'ZPL' | 'PDF';
  width_mm?: number;
  height_mm?: number;
  content: string;
  required_fields: string[];
}

interface TestPrintBody {
  warehouse_id: string;
  edge_agent_id: string;
  peripheral_device_id: string;
  device_code: string;
  fields: Record<string, string>;
}

interface WarehouseBody {
  warehouse_id: string;
}

interface ReprintBody {
  warehouse_id: string;
  edge_agent_id: string;
  peripheral_device_id: string;
  device_code: string;
  template_code: 'LPN_PALETE' | 'LPN_VOLUME' | 'ENDERECO' | 'LOTE_INTERNO';
  fields: Record<string, string>;
  print_entity: string;
  print_entity_id: string;
  reason: string;
}

@Controller('perifericos/etiquetas')
@UseGuards(PermissionGuard)
export class LabelTemplateController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(LabelTemplateService) private readonly labelTemplateService: LabelTemplateService,
    @Inject(PeripheralJobService) private readonly peripheralJobService: PeripheralJobService
  ) {}

  @RequirePermission('PER.GESTAO_TEMPLATES')
  @Post('templates')
  createDraft(@Body() body: CreateDraftBody, @CurrentUser() principal: RequestPrincipal) {
    return this.labelTemplateService.createDraftVersion({
      code: body.code,
      format: body.format,
      widthMm: body.width_mm,
      heightMm: body.height_mm,
      content: body.content,
      requiredFields: body.required_fields,
      warehouseId: body.warehouse_id,
      actorUserId: principal.userId,
    });
  }

  /** RN-PER-020: solicita a impressão de teste — o job PRINT_ZPL resultante é o que approve() exige CONCLUIDO. */
  @RequirePermission('PER.GESTAO_TEMPLATES')
  @Post('templates/:id/teste')
  async requestTestPrint(@Param('id') templateId: string, @Body() body: TestPrintBody, @CurrentUser() principal: RequestPrincipal) {
    const job = await this.peripheralJobService.createTestPrintJob({
      templateId,
      fields: body.fields,
      edgeAgentId: body.edge_agent_id,
      peripheralDeviceId: body.peripheral_device_id,
      deviceCode: body.device_code,
      warehouseId: body.warehouse_id,
      actorUserId: principal.userId,
    });
    await this.labelTemplateService.markTestPrintRequested(templateId, job.job_id, principal.userId);
    return job;
  }

  @RequirePermission('PER.GESTAO_TEMPLATES')
  @Post('templates/:id/aprovar')
  approve(@Param('id') templateId: string, @Body() body: WarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.labelTemplateService.approveTestPrint(templateId, body.warehouse_id, principal.userId);
  }

  @RequirePermission('PER.GESTAO_TEMPLATES')
  @Post('templates/:id/ativar')
  activate(@Param('id') templateId: string, @Body() body: WarehouseBody, @CurrentUser() principal: RequestPrincipal) {
    return this.labelTemplateService.activate(templateId, body.warehouse_id, principal.userId);
  }

  /** RF-PER-021: reimpressão — exige motivo, marca RE1/RE2/... e é auditada PRINT. */
  @RequirePermission('PER.REIMPRESSAO')
  @Post('reimprimir')
  reprint(@Body() body: ReprintBody, @CurrentUser() principal: RequestPrincipal) {
    return this.peripheralJobService.createLabelPrintJob({
      edgeAgentId: body.edge_agent_id,
      peripheralDeviceId: body.peripheral_device_id,
      deviceCode: body.device_code,
      warehouseId: body.warehouse_id,
      templateCode: body.template_code,
      fields: body.fields,
      printEntity: body.print_entity,
      printEntityId: body.print_entity_id,
      actorUserId: principal.userId,
      reason: body.reason,
    });
  }
}
