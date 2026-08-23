// DOC-11 RN-PER-020 [INVIOLÁVEL] — label_template: versionamento e porta de
// ativação ("ativação de versão exige impressão de teste aprovada"). Não
// depende de PeripheralJobService (evita ciclo — ver comentário em
// jobs/peripheral-job.service.ts): o job de teste é criado pelo CONTROLLER,
// que já tem os dois services injetados; este service só lê
// wms.peripheral_job (tabela, não a classe) para confirmar CONCLUIDO antes
// de aprovar.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { renderPlaceholders, validateRequiredFields } from './label-render.util.js';

export interface CreateDraftVersionInput {
  code: 'LPN_PALETE' | 'LPN_VOLUME' | 'ENDERECO' | 'LOTE_INTERNO' | 'CONTEUDO_PALETE';
  format: 'ZPL' | 'PDF';
  widthMm?: number;
  heightMm?: number;
  content: string;
  requiredFields: string[];
  actorUserId: string;
  // RD-SEG-030: audit_log exige warehouse_id (exceto LOGIN/LOGOUT) — mesmo
  // label_template sendo GLOBAL (RN-PER-020, sem afinidade de armazém), a
  // AÇÃO de editá-lo é feita por um admin operando a partir de algum
  // armazém; o controller exige esse campo no body só para rastreabilidade
  // do audit_log, não para autorização (PER.GESTAO_TEMPLATES é GLOBAL).
  warehouseId: string;
}

@Injectable()
export class LabelTemplateService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async getActiveTemplate(code: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.label_template WHERE code = $1 AND status = 'ACTIVE'`, [code]);
    const template = result.rows[0];
    if (!template) throw new NotFoundException(`RN-PER-020: nenhuma versão ACTIVE do template ${code}`);
    return template;
  }

  async getById(id: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.label_template WHERE id = $1`, [id]);
    const template = result.rows[0];
    if (!template) throw new NotFoundException(`label_template ${id} not found`);
    return template;
  }

  /** RN-PER-020: nova versão sempre nasce DRAFT, mesmo para um `code` que já tem versão ACTIVE. */
  async createDraftVersion(input: CreateDraftVersionInput) {
    const versionResult = await this.db.queryGlobal<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM wms.label_template WHERE code = $1`,
      [input.code]
    );
    const version = versionResult.rows[0].next;

    const result = await this.db.queryGlobal(
      `INSERT INTO wms.label_template (code, version, format, width_mm, height_mm, content, required_fields, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8) RETURNING *`,
      [input.code, version, input.format, input.widthMm ?? null, input.heightMm ?? null, input.content, input.requiredFields, input.actorUserId]
    );
    const template = result.rows[0];

    await this.auditService.record({
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'WEB',
      entity: 'label_template',
      entityId: template.id,
      action: 'CREATE',
      requirementId: 'DOC-11 RN-PER-020',
      after: template,
    });

    return template;
  }

  /** Chamado pelo controller depois de criar o job de impressão de teste (RF-PER-021 job PRINT_ZPL). */
  async markTestPrintRequested(templateId: string, jobId: string, actorUserId: string) {
    const template = await this.getById(templateId);
    if (template.status !== 'DRAFT') {
      throw new BadRequestException({ error: 'TEMPLATE_NOT_DRAFT', detail: `RN-PER-020: template ${templateId} não está DRAFT (status atual: ${template.status})` });
    }
    const result = await this.db.queryGlobal(
      `UPDATE wms.label_template SET status = 'TEST_PRINT_PENDING', test_print_job_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [templateId, jobId, actorUserId]
    );
    return result.rows[0];
  }

  /**
   * RN-PER-020 [INVIOLÁVEL]: só aprova se o job de impressão de teste
   * vinculado terminou CONCLUIDO — o pedido de aprovação é sobre uma
   * etiqueta FISICAMENTE impressa e conferida, não sobre a intenção.
   */
  async approveTestPrint(templateId: string, warehouseId: string, actorUserId: string) {
    const template = await this.getById(templateId);
    if (template.status !== 'TEST_PRINT_PENDING') {
      throw new BadRequestException({ error: 'TEMPLATE_NOT_PENDING', detail: `RN-PER-020: template ${templateId} não está TEST_PRINT_PENDING (status atual: ${template.status})` });
    }

    const jobResult = await this.db.queryGlobal<{ state: string }>(`SELECT state FROM wms.peripheral_job WHERE job_id = $1`, [template.test_print_job_id]);
    const job = jobResult.rows[0];
    if (!job || job.state !== 'CONCLUIDO') {
      throw new BadRequestException({
        error: 'TEST_PRINT_NOT_COMPLETED',
        detail: `RN-PER-020: o job de impressão de teste ${template.test_print_job_id} ainda não está CONCLUIDO (estado: ${job?.state ?? 'inexistente'})`,
      });
    }

    const result = await this.db.queryGlobal(
      `UPDATE wms.label_template SET status = 'APPROVED', approved_at = now(), approved_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [templateId, actorUserId]
    );

    await this.auditService.record({
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'label_template',
      entityId: templateId,
      action: 'APPROVE',
      requirementId: 'DOC-11 RN-PER-020',
      after: result.rows[0],
    });

    return result.rows[0];
  }

  /** RN-PER-020: ativa a versão APPROVED, retirando a versão ACTIVE anterior do mesmo `code` (no máximo 1 ACTIVE por code). */
  async activate(templateId: string, warehouseId: string, actorUserId: string) {
    const template = await this.getById(templateId);
    if (template.status !== 'APPROVED') {
      throw new BadRequestException({ error: 'TEMPLATE_NOT_APPROVED', detail: `RN-PER-020: template ${templateId} não está APPROVED (status atual: ${template.status})` });
    }

    const activated = await this.db.transactionGlobal(async (client) => {
      await client.query(`UPDATE wms.label_template SET status = 'RETIRED', updated_at = now(), updated_by = $2 WHERE code = $1 AND status = 'ACTIVE'`, [
        template.code,
        actorUserId,
      ]);
      const result = await client.query(
        `UPDATE wms.label_template SET status = 'ACTIVE', activated_at = now(), activated_by = $2, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [templateId, actorUserId]
      );
      return result.rows[0];
    });

    await this.auditService.record({
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'label_template',
      entityId: templateId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-11 RN-PER-020',
      after: activated,
    });

    return activated;
  }

  /** Renderização pura — usada tanto para o job de teste (template DRAFT/*) quanto para impressão real (template ACTIVE). */
  render(template: { content: string | null; required_fields: string[]; format: string }, fields: Record<string, string>): string {
    if (template.format !== 'ZPL' || !template.content) {
      throw new BadRequestException({ error: 'TEMPLATE_NOT_RENDERABLE', detail: 'DOC-11: renderização automática só existe para templates ZPL (PDF é fora de escopo desta sessão — RNF-PER-031 exige o PDF já pronto do chamador)' });
    }
    validateRequiredFields(template.required_fields, fields);
    return renderPlaceholders(template.content, fields);
  }
}
