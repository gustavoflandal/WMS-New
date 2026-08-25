// DOC-17 §8 — Transcrição de Formulário de Campo (RF-TEL-030, RN-TEL-031/
// 032/033, RF-TEL-034). Ver docs/PROMPT-SESSAO-10D-doc17-transcricao.md.
//
// PARIDADE [INVIOLÁVEL] (RN-TEL-011): cada linha é efetivada pelo MESMO
// serviço de domínio que o coletor usa — `PutawayTaskService.executeTask()`.
// Este service NÃO credita saldo, não valida endereço e não decide override:
// ele traduz o que foi anotado no papel para a chamada do domínio e registra
// o resultado. É PROIBIDO criar aqui qualquer validação alternativa.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { PutawayTaskService } from '../../recebimento/putaway/putaway-task.service.js';
import { compareDoubleEntry, requiresDoubleEntry, DoubleEntryLine } from './double-entry.util.js';

/** Uma linha do formulário conforme anotada no campo. */
export interface TranscribedLineInput {
  lineNumber: number;
  /** RN-TEL-031 item 4: linha não preenchida no papel fica pendente, não vira efeito. */
  notFilled?: boolean;
  /** RG-007/RN-DAD-011 — leitura 1, DIGITADA (RN-TEL-012 item 1). */
  scannedLpn?: string;
  /** RN-DAD-011 — leitura 2, DIGITADA. */
  scannedLocationCode?: string;
  /** RN-REC-041 — obrigatório quando o endereço difere do sugerido. */
  overrideReason?: string;
  /** RF-TEL-034 — 1ª e 2ª passagens da quantidade (só para tipos que exigem). */
  qtyFirstPass?: number;
  qtySecondPass?: number;
}

export interface TranscribeInput {
  tenantId: string;
  warehouseId: string;
  fieldFormId: string;
  lines: TranscribedLineInput[];
  /** RN-TEL-032 — exceção TEL.SEGREGACAO_TRANSCRICAO APROVADA, quando o executante transcreve a si mesmo. */
  segregationExceptionId?: string | null;
  /** RN-TEL-033 — exceção TEL.FORMULARIO_EXPIRADO APROVADA, quando fora da validade. */
  expiryExceptionId?: string | null;
}

export type LineStatus = 'APLICADA' | 'DESCARTADA_DUPLICIDADE' | 'REJEITADA_REGRA' | 'NAO_PREENCHIDA';

export interface TranscribedLineResult {
  lineNumber: number;
  status: LineStatus;
  detail?: string;
}

export interface TranscriptionResult {
  transcriptionId: string;
  fieldFormId: string;
  formStatus: string;
  lines: TranscribedLineResult[];
  /** RN-TEL-031 item 2 — true quando é o replay de uma transcrição já feita. */
  idempotentReplay: boolean;
  transcribedBy?: string;
  transcribedAt?: string;
}

@Injectable()
export class TranscriptionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(PutawayTaskService) private readonly putawayTaskService: PutawayTaskService
  ) {}

  /** RF-TEL-030 — localiza o formulário pelo NÚMERO (é o que o digitador lê do papel / do Code 128). */
  async findByNumber(number: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.query(ctx, `SELECT * FROM wms.field_form WHERE number = $1 AND warehouse_id = $2`, [number, warehouseId]);
    const form = result.rows[0];
    if (!form) throw new NotFoundException(`field_form número ${number} não encontrado neste armazém`);
    const lines = await this.db.query(ctx, `SELECT * FROM wms.field_form_line WHERE field_form_id = $1 ORDER BY line_number`, [form.id]);
    return { form, lines: lines.rows };
  }

  async transcribe(input: TranscribeInput, actorUserId: string): Promise<TranscriptionResult> {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };

    const formResult = await this.db.query(ctx, `SELECT * FROM wms.field_form WHERE id = $1`, [input.fieldFormId]);
    const form = formResult.rows[0];
    if (!form) throw new NotFoundException(`field_form ${input.fieldFormId} not found`);

    // ── RN-TEL-031 item 2 [INVIOLÁVEL] — um formulário só é transcrito UMA
    // vez. Nova tentativa devolve o resultado ORIGINAL, sem efeito adicional,
    // dizendo quando e por quem foi transcrito. Verificado ANTES de tudo.
    const existing = await this.db.query(ctx, `SELECT * FROM wms.form_transcription WHERE field_form_id = $1`, [input.fieldFormId]);
    if (existing.rows[0]) {
      const t = existing.rows[0];
      return {
        transcriptionId: t.id,
        fieldFormId: input.fieldFormId,
        formStatus: form.status,
        lines: (t.result?.lines ?? []) as TranscribedLineResult[],
        idempotentReplay: true,
        transcribedBy: t.transcribed_by,
        transcribedAt: new Date(t.finished_at ?? t.started_at).toISOString(),
      };
    }

    if (!['EMITIDO', 'EM_TRANSCRICAO', 'PARCIALMENTE_TRANSCRITO'].includes(form.status)) {
      throw new BadRequestException({
        error: 'FORM_NOT_TRANSCRIBABLE',
        detail: `DOC-17 §9.1: formulário em ${form.status} não aceita transcrição (cancelado, expirado ou substituído)`,
      });
    }

    // ── RN-TEL-032 — segregação de funções ────────────────────────────────
    await this.assertSegregation(ctx, form, input.segregationExceptionId ?? null, actorUserId);

    // ── RN-TEL-033 — validade ─────────────────────────────────────────────
    await this.assertValidity(ctx, form, input.expiryExceptionId ?? null, actorUserId);

    const linesResult = await this.db.query(ctx, `SELECT * FROM wms.field_form_line WHERE field_form_id = $1 ORDER BY line_number`, [input.fieldFormId]);
    const formLines = linesResult.rows;

    // ── RF-TEL-034 — dupla digitação ANTES de qualquer efeito ─────────────
    await this.assertDoubleEntry(ctx, form, input.lines);

    // ── Aplicação linha a linha ───────────────────────────────────────────
    const results: TranscribedLineResult[] = [];
    for (const formLine of formLines) {
      const typed = input.lines.find((l) => l.lineNumber === formLine.line_number);
      results.push(await this.applyLine(ctx, form, formLine, typed, actorUserId));
    }

    // ── RN-TEL-031 item 4 — parcial é permitida e retomável ───────────────
    const anyPending = results.some((r) => r.status === 'NAO_PREENCHIDA');
    const formStatus = anyPending ? 'PARCIALMENTE_TRANSCRITO' : 'TRANSCRITO';

    const transcription = await this.db.transaction(ctx, async (client) => {
      for (const r of results) {
        await client.query(`UPDATE wms.field_form_line SET status = $2, motivo = $3 WHERE field_form_id = $1 AND line_number = $4`, [
          input.fieldFormId,
          r.status,
          r.detail ?? null,
          r.lineNumber,
        ]);
      }
      await client.query(`UPDATE wms.field_form SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [input.fieldFormId, formStatus, actorUserId]);
      const inserted = await client.query(
        `INSERT INTO wms.form_transcription (tenant_id, warehouse_id, field_form_id, transcribed_by, finished_at, segregation_exception_id, expiry_exception_id, result, created_by)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$4) RETURNING *`,
        [input.tenantId, input.warehouseId, input.fieldFormId, actorUserId, input.segregationExceptionId ?? null, input.expiryExceptionId ?? null, JSON.stringify({ lines: results })]
      );
      return inserted.rows[0];
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      // RN-TEL-012 item 3 — origem PAPEL (enum alargado na migration 0076).
      origin: 'PAPEL',
      entity: 'form_transcription',
      entityId: transcription.id,
      action: 'CREATE',
      requirementId: 'DOC-17 RF-TEL-030',
      after: { field_form_id: input.fieldFormId, form_status: formStatus, lines: results },
    });

    return {
      transcriptionId: transcription.id,
      fieldFormId: input.fieldFormId,
      formStatus,
      lines: results,
      idempotentReplay: false,
      transcribedBy: actorUserId,
      transcribedAt: new Date(transcription.finished_at).toISOString(),
    };
  }

  /**
   * Efetiva UMA linha pelo serviço de domínio (RN-TEL-011). Nunca aplica
   * efeito próprio: traduz o anotado no papel para a chamada do domínio.
   */
  private async applyLine(
    ctx: TenantContext,
    form: { id: string; declared_executor_user_id: string | null },
    formLine: { line_number: number; task_entity: string | null; task_entity_id: string | null; form_line_id: string },
    typed: TranscribedLineInput | undefined,
    actorUserId: string
  ): Promise<TranscribedLineResult> {
    // RN-TEL-031 item 4 — linha em branco no papel permanece pendente.
    if (!typed || typed.notFilled) {
      return { lineNumber: formLine.line_number, status: 'NAO_PREENCHIDA', detail: 'Linha não preenchida no formulário' };
    }

    if (formLine.task_entity !== 'putaway_task' || !formLine.task_entity_id) {
      // Honesto: a 10B só ligou Putaway a uma tabela de tarefa real. Rejeitar
      // é melhor que ignorar em silêncio — o digitador precisa saber que a
      // linha não foi aplicada. [DEBITO: 10B]
      return {
        lineNumber: formLine.line_number,
        status: 'REJEITADA_REGRA',
        detail: `Tipo de tarefa "${formLine.task_entity ?? 'sem vínculo'}" ainda não tem aplicação por transcrição (DEBITO 10B — só putaway_task)`,
      };
    }

    // RN-TEL-031 item 3 — tarefa já concluída por outro canal é DESCARTADA
    // com aviso, sem efeito. Mesma semântica do offline (RN-ARQ-053).
    const taskResult = await this.db.query(ctx, `SELECT status FROM wms.putaway_task WHERE id = $1`, [formLine.task_entity_id]);
    const task = taskResult.rows[0];
    if (!task) {
      return { lineNumber: formLine.line_number, status: 'REJEITADA_REGRA', detail: `Tarefa ${formLine.task_entity_id} não encontrada` };
    }
    if (task.status === 'DONE') {
      return { lineNumber: formLine.line_number, status: 'DESCARTADA_DUPLICIDADE', detail: 'Tarefa já concluída por outro canal — nenhum efeito aplicado' };
    }
    if (task.status === 'CANCELLED') {
      return { lineNumber: formLine.line_number, status: 'REJEITADA_REGRA', detail: 'Tarefa cancelada' };
    }

    if (!typed.scannedLpn || !typed.scannedLocationCode) {
      // RN-TEL-012 item 1: os códigos são DIGITADOS e validados; sem eles não
      // há como aplicar a dupla verificação que o modo papel já perdeu.
      return { lineNumber: formLine.line_number, status: 'REJEITADA_REGRA', detail: 'RN-TEL-012: LPN e código de endereço são obrigatórios (digitados)' };
    }

    try {
      // A tarefa precisa estar ASSIGNED para executar (§5.2). Quem executou
      // foi o executante declarado no formulário; na falta de vínculo com
      // usuário real, o próprio transcritor responde pela atribuição.
      if (['CREATED', 'REJECTED_SCAN'].includes(task.status)) {
        await this.putawayTaskService.assignTask(
          formLine.task_entity_id,
          form.declared_executor_user_id ?? actorUserId,
          ctx.tenant_id,
          ctx.warehouse_id as string,
          actorUserId,
          null,
          form.id // atravessa a guarda de RN-TEL-021 só para ESTE formulário
        );
      }

      await this.putawayTaskService.executeTask(
        formLine.task_entity_id,
        {
          // RN-TEL-031 item 1 [INVIOLÁVEL]: a chave de idempotência da LINHA
          // é a chave da operação. Reprocessar não duplica efeito porque o
          // mecanismo de RNF-ARQ-050 já existente reconhece a mesma chave.
          operationId: formLine.form_line_id,
          scannedLpn: typed.scannedLpn,
          scannedLocationCode: typed.scannedLocationCode,
          overrideReason: typed.overrideReason,
          origin: 'PAPEL',
        },
        ctx.tenant_id,
        ctx.warehouse_id as string,
        actorUserId
      );
      return { lineNumber: formLine.line_number, status: 'APLICADA' };
    } catch (error) {
      // RN-TEL-033: "quando o módulo exigir aprovação, a linha fica pendente
      // — NUNCA é aplicada parcialmente". A rejeição do módulo de origem
      // (endereço divergente sem permissão, LPN errado, espécie incompatível)
      // vira REJEITADA_REGRA com o motivo EXATO do domínio, sem reinterpretar.
      const detail = (error as { response?: { error?: string; detail?: string } })?.response;
      return {
        lineNumber: formLine.line_number,
        status: 'REJEITADA_REGRA',
        detail: detail?.detail ?? detail?.error ?? (error as Error).message,
      };
    }
  }

  /** RN-TEL-032 — segregação de funções. */
  private async assertSegregation(ctx: TenantContext, form: { id: string; declared_executor_user_id: string | null }, exceptionId: string | null, actorUserId: string): Promise<void> {
    // Sem vínculo com usuário real não há segregação a aferir (executante
    // externo/temporário). Fica registrado pela ausência de exceção.
    if (!form.declared_executor_user_id) return;
    if (form.declared_executor_user_id !== actorUserId) return;

    // RN-TEL-032: "ONDE o parâmetro TEL.EXIGE_SEGREGACAO_TRANSCRICAO estiver
    // ativo (padrão TRUE)". Ausência do parâmetro DEVE valer como ativo —
    // este é um controle antifraude (é a única verificação independente que
    // sobra no papel), e falhar aberto em parâmetro não configurado seria
    // desligá-lo em silêncio justamente na instalação que ainda não foi
    // parametrizada. Só o valor explícito 'false' desliga.
    const required = await this.resolveParameter(ctx, 'TEL.EXIGE_SEGREGACAO_TRANSCRICAO');
    if (required === 'false') return;

    const hasOwnPermission = await this.rbacService.hasPermission(actorUserId, 'TEL.TRANSCREVER_PROPRIO', {
      clientId: ctx.tenant_id,
      warehouseId: ctx.warehouse_id as string,
    });
    if (!hasOwnPermission) {
      throw new ForbiddenException({
        error: 'SEGREGATION_VIOLATION',
        detail:
          'DOC-17 RN-TEL-032: o executante do formulário não pode transcrevê-lo. ' +
          'No papel, quem anota e quem digita ser a mesma pessoa elimina a única verificação independente restante.',
      });
    }
    // Com a permissão, a dispensa EXIGE exceção registrada (RN-TEL-032).
    if (!exceptionId) {
      throw new ConflictException({
        error: 'SEGREGATION_EXCEPTION_REQUIRED',
        detail: 'DOC-17 RN-TEL-032: transcrever o próprio formulário registra exceção TEL.SEGREGACAO_TRANSCRICAO — informe a exceção aprovada',
      });
    }
    await this.assertExceptionApproved(ctx, exceptionId, 'TEL.SEGREGACAO_TRANSCRICAO', form.id);
  }

  /** RN-TEL-033 — transcrição após a validade exige TEL.FORMULARIO_EXPIRADO. */
  private async assertValidity(ctx: TenantContext, form: { id: string; valid_until: string }, exceptionId: string | null, actorUserId: string): Promise<void> {
    if (new Date(form.valid_until).getTime() >= Date.now()) return;

    if (!exceptionId) {
      const exception = await this.operationalExceptionService.create({
        tenantId: ctx.tenant_id,
        exceptionType: 'TEL.FORMULARIO_EXPIRADO',
        warehouseId: ctx.warehouse_id as string,
        entity: 'field_form',
        entityId: form.id,
        reasonRequest: `RN-TEL-033: transcrição tentada após a validade (${form.valid_until})`,
        requestedBy: actorUserId,
      });
      throw new ConflictException({
        error: 'FORM_EXPIRED',
        detail: `DOC-17 RN-TEL-033: formulário fora da validade — exceção TEL.FORMULARIO_EXPIRADO ${(exception as { id: string }).id} aberta; a transcrição só prossegue após aprovação`,
        exception_id: (exception as { id: string }).id,
      });
    }
    await this.assertExceptionApproved(ctx, exceptionId, 'TEL.FORMULARIO_EXPIRADO', form.id);
  }

  /** RF-TEL-034 — dupla digitação, quando exigida pelo tipo do formulário. */
  private async assertDoubleEntry(ctx: TenantContext, form: { form_type: string }, lines: TranscribedLineInput[]): Promise<void> {
    const raw = await this.resolveParameter(ctx, 'TEL.DUPLA_DIGITACAO');
    let parameter: Record<string, boolean> | null = null;
    try {
      parameter = raw ? (JSON.parse(raw) as Record<string, boolean>) : null;
    } catch {
      parameter = null;
    }
    if (!requiresDoubleEntry(form.form_type, parameter)) return;

    const filled = lines.filter((l) => !l.notFilled);
    const missing = filled.filter((l) => l.qtyFirstPass === undefined || l.qtySecondPass === undefined);
    if (missing.length > 0) {
      throw new BadRequestException({
        error: 'DOUBLE_ENTRY_REQUIRED',
        detail: `DOC-17 RF-TEL-034: ${form.form_type} exige duas passagens de quantidade; faltam nas linhas ${missing.map((l) => l.lineNumber).join(', ')}`,
      });
    }

    const outcome = compareDoubleEntry(filled.map<DoubleEntryLine>((l) => ({ lineNumber: l.lineNumber, firstPass: l.qtyFirstPass as number, secondPass: l.qtySecondPass as number })));
    if (!outcome.matches) {
      throw new ConflictException({
        error: 'DOUBLE_ENTRY_DIVERGENCE',
        detail: 'DOC-17 RF-TEL-034: divergência entre as passagens — nada é gravado até a resolução',
        divergences: outcome.divergences,
      });
    }
  }

  private async assertExceptionApproved(ctx: TenantContext, exceptionId: string, expectedType: string, formId: string): Promise<void> {
    const result = await this.db.query<{ status: string; exception_type: string; entity: string; entity_id: string }>(
      ctx,
      `SELECT status, exception_type, entity, entity_id FROM wms.operational_exception WHERE id = $1`,
      [exceptionId]
    );
    const exception = result.rows[0];
    if (!exception) throw new NotFoundException(`operational_exception ${exceptionId} not found`);
    if (exception.exception_type !== expectedType) {
      throw new BadRequestException({ error: 'WRONG_EXCEPTION_TYPE', detail: `Esperado ${expectedType}, recebido ${exception.exception_type}` });
    }
    if (exception.entity !== 'field_form' || exception.entity_id !== formId) {
      throw new BadRequestException({ error: 'EXCEPTION_ENTITY_MISMATCH', detail: `A exceção ${exceptionId} não pertence ao formulário ${formId}` });
    }
    if (exception.status !== 'APPROVED') {
      throw new ConflictException({ error: 'EXCEPTION_NOT_APPROVED', detail: `${expectedType} precisa estar APROVADA antes da transcrição (status atual: ${exception.status})` });
    }
  }

  private async resolveParameter(ctx: TenantContext, name: string): Promise<string | null> {
    const result = await this.db.query<{ value: string }>(
      ctx,
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 AND (scope = 'GLOBAL' OR (scope = 'WAREHOUSE' AND warehouse_id = $2))
       ORDER BY CASE scope WHEN 'WAREHOUSE' THEN 0 ELSE 1 END
       LIMIT 1`,
      [name, ctx.warehouse_id]
    );
    return result.rows[0]?.value ?? null;
  }
}
