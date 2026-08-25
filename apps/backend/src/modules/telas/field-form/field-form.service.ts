// DOC-17 §7 — Formulário de Campo (RF-TEL-020 a RF-TEL-024, RN-TEL-021,
// RN-TEL-023). Ver docs/PROMPT-SESSAO-10B-doc17-formulario-campo.md para as
// decisões de escopo: só PUTAWAY está ligado a `wms.putaway_task` de ponta a
// ponta nesta sessão (decisão 1); as demais 5 linhas do catálogo RF-TEL-022
// ficam com a função de conteúdo pronta (field-form-content.util.ts) mas sem
// hook de reserva real — [DEBITO: 10B].
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { PutawayTaskService } from '../../recebimento/putaway/putaway-task.service.js';
import { PutawayEngineService } from '../../recebimento/putaway/putaway-engine.service.js';
import { FieldFormPdfService } from './field-form-pdf.service.js';
import { buildPutawayLineContent } from './field-form-content.util.js';

export interface EmitPutawayFormInput {
  tenantId: string;
  warehouseId: string;
  taskIds: string[];
  declaredExecutorName: string;
  declaredExecutorRegistration?: string | null;
}

export interface CancelFormInput {
  tenantId: string;
  warehouseId: string;
  formId: string;
  reason: string;
}

export interface ReissueFormInput {
  tenantId: string;
  warehouseId: string;
  formId: string;
  reason: string;
}

const DEFAULT_VALIDITY_H = 12;

@Injectable()
export class FieldFormService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService,
    @Inject(PutawayTaskService) private readonly putawayTaskService: PutawayTaskService,
    @Inject(PutawayEngineService) private readonly putawayEngineService: PutawayEngineService,
    @Inject(FieldFormPdfService) private readonly fieldFormPdfService: FieldFormPdfService
  ) {}

  /** RF-TEL-020/RN-TEL-021 — emissão para a operação Putaway (T-P1). */
  async emitPutawayForm(input: EmitPutawayFormInput, actorUserId: string) {
    if (input.taskIds.length === 0) {
      throw new BadRequestException({ error: 'NO_TASKS', detail: 'DOC-17 RF-TEL-020: informe ao menos uma tarefa para emitir o formulário' });
    }
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };
    const warehouseCode = await this.loadWarehouseCode(input.warehouseId);

    const lockable = await this.putawayTaskService.loadLockableTasks(input.taskIds, input.tenantId, input.warehouseId, actorUserId);
    const lockableIds = new Set(lockable.map((t) => t.id));
    const missing = input.taskIds.filter((id) => !lockableIds.has(id));
    if (missing.length > 0) {
      throw new BadRequestException({
        error: 'TASK_NOT_LOCKABLE',
        detail: `DOC-17 RN-TEL-021: tarefa(s) não disponível(is) para reserva (já atribuída, em outro formulário ou inexistente): ${missing.join(', ')}`,
      });
    }

    const validUntil = new Date(Date.now() + (await this.resolveValidityHours(ctx)) * 3_600_000);

    const lineContents: { taskId: string; content: Record<string, unknown> }[] = [];
    for (const task of lockable) {
      const engineResult = await this.putawayEngineService.suggestLocations(task.pallet_id, input.tenantId, input.warehouseId, actorUserId);
      if (!engineResult.suggestion) {
        throw new BadRequestException({
          error: 'NO_LOCATION_APPROVED',
          detail: `DOC-17/RN-REC-040: nenhum endereço aprovado para a tarefa ${task.id} (palete ${task.lpn}) — não é possível imprimir endereço sugerido`,
        });
      }
      const productDescription = await this.loadPalletContentDescription(ctx, task.pallet_id);
      lineContents.push({
        taskId: task.id,
        content: buildPutawayLineContent({
          lpn: task.lpn,
          productDescription,
          locationSuggestedCode: engineResult.suggestion.code,
          alternativeCodes: engineResult.alternatives.map((a) => a.code),
        }),
      });
    }

    const form = await this.db.transaction(ctx, async (client) => {
      const number = await this.documentNumberingService.generateDocumentNumber(client, 'FIELD_FORM', input.warehouseId, warehouseCode, actorUserId);
      const formResult = await client.query(
        `INSERT INTO wms.field_form (tenant_id, warehouse_id, number, form_type, status, valid_until, declared_executor_name, declared_executor_registration, created_by)
         VALUES ($1,$2,$3,'PUTAWAY','EMITIDO',$4,$5,$6,$7) RETURNING *`,
        [input.tenantId, input.warehouseId, number, validUntil, input.declaredExecutorName, input.declaredExecutorRegistration ?? null, actorUserId]
      );
      const formRow = formResult.rows[0];

      let lineNumber = 1;
      for (const { taskId, content } of lineContents) {
        await client.query(
          `INSERT INTO wms.field_form_line (tenant_id, field_form_id, line_number, task_entity, task_entity_id, previsto, created_by)
           VALUES ($1,$2,$3,'putaway_task',$4,$5,$6)`,
          [input.tenantId, formRow.id, lineNumber, taskId, JSON.stringify(content), actorUserId]
        );
        await this.putawayTaskService.lockForFieldForm(client, taskId, formRow.id, actorUserId);
        lineNumber += 1;
      }
      return formRow;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'field_form',
      entityId: form.id,
      action: 'CREATE',
      requirementId: 'DOC-17 RF-TEL-020/RN-TEL-021',
      after: { number: form.number, form_type: 'PUTAWAY', task_count: lineContents.length },
    });

    const pdfKey = await this.generateAndStorePdf(ctx, form, lineContents.map((l, i) => ({ lineNumber: i + 1, previsto: l.content })), warehouseCode);
    return { ...form, pdf_storage_key: pdfKey };
  }

  /** RF-TEL-024 — cancelamento: devolve as tarefas à fila (RN-TEL-021). */
  async cancel(input: CancelFormInput, actorUserId: string) {
    if (!input.reason?.trim()) throw new BadRequestException({ error: 'REASON_REQUIRED', detail: 'DOC-17 RF-TEL-024: cancelamento exige motivo' });
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };
    const form = await this.loadForm(ctx, input.formId);
    if (form.status !== 'EMITIDO') {
      throw new BadRequestException({ error: 'FORM_NOT_CANCELABLE', detail: `DOC-17 §9.1: só formulário EMITIDO pode ser cancelado (status atual: ${form.status})` });
    }

    const updated = await this.db.transaction(ctx, async (client) => {
      await this.putawayTaskService.releaseFieldFormLock(client, form.id, actorUserId);
      const result = await client.query(
        `UPDATE wms.field_form SET status = 'CANCELADO', cancel_reason = $2, cancelled_at = now(), cancelled_by = $3, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [form.id, input.reason, actorUserId]
      );
      return result.rows[0];
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'field_form',
      entityId: form.id,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-17 RF-TEL-024/RN-TEL-021',
      before: form,
      after: updated,
      reason: input.reason,
    });
    return updated;
  }

  /** RF-TEL-024 — reemissão: novo formulário RE<n>, o original vira SUBSTITUIDO. */
  async reissue(input: ReissueFormInput, actorUserId: string) {
    if (!input.reason?.trim()) throw new BadRequestException({ error: 'REASON_REQUIRED', detail: 'DOC-17 RF-TEL-024: reemissão exige motivo' });
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };
    const original = await this.loadForm(ctx, input.formId);
    if (original.status !== 'EMITIDO') {
      throw new BadRequestException({ error: 'FORM_NOT_REISSUABLE', detail: `DOC-17 RF-TEL-024: só formulário EMITIDO pode ser reemitido (status atual: ${original.status})` });
    }

    const originalLines = await this.db.query(ctx, `SELECT * FROM wms.field_form_line WHERE field_form_id = $1 ORDER BY line_number`, [original.id]);
    const reissueSeq = original.reissue_seq + 1;
    // Marca RE1/RE2... anexada ao número (mesmo padrão RF-PER-021 das etiquetas)
    // — não um número novo da sequência RN-DAD-040, para manter a linhagem
    // rastreável no próprio número impresso.
    const newNumber = `${original.number}-RE${reissueSeq}`;

    const created = await this.db.transaction(ctx, async (client) => {
      const insertResult = await client.query(
        `INSERT INTO wms.field_form (tenant_id, warehouse_id, number, form_type, status, valid_until, declared_executor_name, declared_executor_registration, reissue_seq, replaces_form_id, created_by)
         VALUES ($1,$2,$3,$4,'EMITIDO',$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          original.tenant_id,
          original.warehouse_id,
          newNumber,
          original.form_type,
          original.valid_until,
          original.declared_executor_name,
          original.declared_executor_registration,
          reissueSeq,
          original.id,
          actorUserId,
        ]
      );
      const newForm = insertResult.rows[0];

      for (const oldLine of originalLines.rows) {
        await client.query(
          `INSERT INTO wms.field_form_line (tenant_id, field_form_id, line_number, task_entity, task_entity_id, previsto, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [oldLine.tenant_id, newForm.id, oldLine.line_number, oldLine.task_entity, oldLine.task_entity_id, oldLine.previsto, actorUserId]
        );
        if (oldLine.task_entity === 'putaway_task') {
          await client.query(`UPDATE wms.putaway_task SET field_form_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [oldLine.task_entity_id, newForm.id, actorUserId]);
        }
      }

      await client.query(`UPDATE wms.field_form SET status = 'SUBSTITUIDO', updated_at = now(), updated_by = $2 WHERE id = $1`, [original.id, actorUserId]);
      return newForm;
    });

    await this.auditService.record({
      tenantId: original.tenant_id,
      warehouseId: original.warehouse_id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'field_form',
      entityId: created.id,
      action: 'CREATE',
      requirementId: 'DOC-17 RF-TEL-024',
      before: { replaces_form_id: original.id, original_number: original.number },
      after: { number: created.number, reissue_seq: created.reissue_seq },
      reason: input.reason,
    });

    const warehouseCode = await this.loadWarehouseCode(original.warehouse_id);
    const pdfKey = await this.generateAndStorePdf(
      ctx,
      created,
      originalLines.rows.map((l) => ({ lineNumber: l.line_number, previsto: l.previsto })),
      warehouseCode
    );
    return { ...created, pdf_storage_key: pdfKey };
  }

  async getForm(tenantId: string, warehouseId: string, formId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    return this.loadForm(ctx, formId);
  }

  async getPdfStorageKey(tenantId: string, warehouseId: string, formId: string, actorUserId: string): Promise<string> {
    const form = await this.getForm(tenantId, warehouseId, formId, actorUserId);
    if (!form.pdf_storage_key) throw new NotFoundException(`field_form ${formId} não tem PDF gerado`);
    return form.pdf_storage_key;
  }

  /**
   * RN-TEL-021 "expiração... devolve as tarefas à fila" — verificação LAZY
   * (ver prompt §7): qualquer leitura de um formulário EMITIDO vencido o
   * transiciona para EXPIRADO e libera as tarefas na mesma passada.
   */
  private async loadForm(ctx: TenantContext, formId: string) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.field_form WHERE id = $1`, [formId]);
    const form = result.rows[0];
    if (!form) throw new NotFoundException(`field_form ${formId} not found`);
    if (form.status === 'EMITIDO' && new Date(form.valid_until).getTime() < Date.now()) {
      return this.db.transaction(ctx, async (client) => {
        await this.putawayTaskService.releaseFieldFormLock(client, form.id, ctx.user_id);
        const result2 = await client.query(`UPDATE wms.field_form SET status = 'EXPIRADO', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`, [form.id, ctx.user_id]);
        return result2.rows[0];
      });
    }
    return form;
  }

  private async resolveValidityHours(ctx: TenantContext): Promise<number> {
    const result = await this.db.query(
      ctx,
      `SELECT value FROM wms.app_parameter
       WHERE name = 'TEL.FORMULARIO_VALIDADE_H'
         AND (scope = 'GLOBAL' OR (scope = 'WAREHOUSE' AND warehouse_id = $1))
       ORDER BY CASE scope WHEN 'WAREHOUSE' THEN 0 ELSE 1 END
       LIMIT 1`,
      [ctx.warehouse_id]
    );
    const raw = result.rows[0]?.value;
    return raw ? Number(raw) : DEFAULT_VALIDITY_H;
  }

  private async loadWarehouseCode(warehouseId: string): Promise<string> {
    // wms.warehouse não tem RLS (tabela GLOBAL) — queryGlobal é seguro aqui.
    const result = await this.db.queryGlobal(`SELECT code FROM wms.warehouse WHERE id = $1`, [warehouseId]);
    const warehouse = result.rows[0];
    if (!warehouse) throw new NotFoundException(`warehouse ${warehouseId} not found`);
    return warehouse.code;
  }

  private async loadPalletContentDescription(ctx: TenantContext, palletId: string): Promise<string> {
    const result = await this.db.query(
      ctx,
      `SELECT string_agg(DISTINCT p.description, ', ') AS description
       FROM wms.pallet_content pc JOIN wms.product p ON p.id = pc.product_id
       WHERE pc.pallet_id = $1`,
      [palletId]
    );
    return result.rows[0]?.description ?? '(conteúdo não encontrado)';
  }

  private async generateAndStorePdf(
    ctx: TenantContext,
    form: { id: string; number: string; form_type: string; issued_at: Date; valid_until: Date; declared_executor_name: string; declared_executor_registration: string | null; reissue_seq: number },
    lines: { lineNumber: number; previsto: Record<string, unknown> }[],
    warehouseCode: string
  ): Promise<string> {
    const pdfKey = await this.fieldFormPdfService.generate({
      id: form.id,
      number: form.number,
      formType: form.form_type,
      warehouseCode,
      issuedAt: new Date(form.issued_at),
      validUntil: new Date(form.valid_until),
      declaredExecutorName: form.declared_executor_name,
      declaredExecutorRegistration: form.declared_executor_registration,
      reissueSeq: form.reissue_seq,
      lines,
    });
    await this.db.query(ctx, `UPDATE wms.field_form SET pdf_storage_key = $2 WHERE id = $1`, [form.id, pdfKey]);
    return pdfKey;
  }
}

