// DOC-06 §4.5 (RF-EXP-040 Volumação) + §4.6 (RF-EXP-050 Pesagem, RN-EXP-051
// [INVIOLÁVEL] Tolerância). Um único serviço porque packing e pesagem
// operam sobre a MESMA entidade (wms.package) e §5.2 não separa suas
// sub-máquinas — ver [LACUNA] na migration 0051 sobre o status de package.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { isFirstPendingStep } from '../order/flow-step-guard.util.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { evaluateWeightTolerance } from './weighing.util.js';

const DEFAULT_TOLERANCE_PCT = 2;

export interface OpenPackageInput {
  tenantId: string;
  warehouseId: string;
  outboundOrderId: string;
  packageTypeCode: string;
  actorUserId: string;
}

export interface DeclareContentInput {
  packageId: string;
  tenantId: string;
  warehouseId: string;
  productId: string;
  batchId?: string | null;
  qty: number;
  actorUserId: string;
}

export interface WeighPackageInput {
  packageId: string;
  tenantId: string;
  warehouseId: string;
  weightKg: number;
  source: 'SCALE' | 'MANUAL';
  reasonText?: string | null;
  actorUserId: string;
}

@Injectable()
export class PackageService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService,
    @Inject(LpnService) private readonly lpnService: LpnService
  ) {}

  /** RF-EXP-040 — abre um novo Volume (LPN próprio, RN-DAD-030). */
  async openPackage(input: OpenPackageInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const typeResult = await this.db.queryGlobal<{ tare_kg: string }>(`SELECT tare_kg FROM wms.package_type WHERE code = $1`, [input.packageTypeCode]);
    const packageType = typeResult.rows[0];
    if (!packageType) throw new NotFoundException(`package_type ${input.packageTypeCode} not found`);

    const created = await this.db.transaction(ctx, async (client) => {
      const lpn = await this.lpnService.generate(client, input.warehouseId, input.actorUserId);
      const seqResult = await client.query(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM wms.package WHERE outbound_order_id = $1`,
        [input.outboundOrderId]
      );
      const sequenceNumber = Number(seqResult.rows[0].next);

      const result = await client.query(
        `INSERT INTO wms.package (
           tenant_id, warehouse_id, outbound_order_id, lpn, package_type_code, tare_kg, sequence_number, status, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8) RETURNING *`,
        [input.tenantId, input.warehouseId, input.outboundOrderId, lpn, input.packageTypeCode, packageType.tare_kg, sequenceNumber, input.actorUserId]
      );
      return result.rows[0];
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'package',
      entityId: created.id,
      action: 'CREATE',
      requirementId: 'DOC-06 RF-EXP-040',
      after: created,
    });

    return created;
  }

  /** RF-EXP-040 — conteúdo declarado por leitura (produto/quantidade). */
  async declareContent(input: DeclareContentInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    if (input.qty <= 0) throw new BadRequestException({ error: 'INVALID_QTY', detail: 'RF-EXP-040: quantidade deve ser > 0' });

    const pkg = await this.loadPackage(input.packageId, ctx);
    if (pkg.status !== 'OPEN') {
      throw new ConflictException({ error: 'PACKAGE_NOT_OPEN', detail: `RF-EXP-040: volume ${input.packageId} não está OPEN (status atual: ${pkg.status})` });
    }

    const itemResult = await this.db.query(
      ctx,
      `SELECT * FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND product_id = $2 AND moved_to_order_id IS NULL`,
      [pkg.outbound_order_id, input.productId]
    );
    const item = itemResult.rows[0];
    if (!item) {
      throw new BadRequestException({ error: 'ITEM_NOT_IN_ORDER', detail: `RF-EXP-040: produto ${input.productId} não pertence ao pedido ${pkg.outbound_order_id}` });
    }

    const created = await this.db.transaction(ctx, async (client) => {
      const result = await client.query(
        `INSERT INTO wms.package_content (tenant_id, package_id, outbound_order_item_id, product_id, batch_id, qty, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.tenantId, input.packageId, item.id, input.productId, input.batchId ?? null, input.qty, input.actorUserId]
      );
      return result.rows[0];
    });

    return created;
  }

  /**
   * RF-EXP-040 — fecha o Volume: calcula o Peso Teórico (§2) e trava o
   * conteúdo. A validação "conteúdo total = separado (nem mais, nem menos)"
   * é da ETAPA (attemptCompletePackingStep), não do fechamento de UM volume
   * — um pedido normalmente tem VÁRIOS volumes.
   */
  async closePackage(packageId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const pkg = await this.loadPackage(packageId, ctx);
    if (pkg.status !== 'OPEN') {
      throw new ConflictException({ error: 'PACKAGE_NOT_OPEN', detail: `RF-EXP-040: volume ${packageId} não está OPEN (status atual: ${pkg.status})` });
    }

    const contentResult = await this.db.query(ctx, `SELECT COUNT(*) AS count FROM wms.package_content WHERE package_id = $1`, [packageId]);
    if (Number(contentResult.rows[0].count) === 0) {
      throw new BadRequestException({ error: 'EMPTY_PACKAGE', detail: 'RF-EXP-040: volume sem conteúdo declarado não pode ser fechado' });
    }

    const updated = await this.db.transaction(ctx, async (client) => {
      const theoreticalKg = await this.computeTheoreticalWeight(client, pkg);
      const result = await client.query(
        `UPDATE wms.package SET status = 'CLOSED', theoretical_weight_kg = $2, closed_at = now(), updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [packageId, theoreticalKg, actorUserId]
      );
      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.volume_criado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { package_id: packageId, outbound_order_id: pkg.outbound_order_id, lpn: pkg.lpn, sequence_number: pkg.sequence_number, theoretical_weight_kg: theoreticalKg },
      });
      return result.rows[0];
    });

    return updated;
  }

  /**
   * Peso Teórico (§2): Σ(quantidade × gross_weight_kg) + tara. Para produto
   * `is_weight_variable`, §4.6 manda usar "o peso apurado no picking como
   * teórico do conteúdo". [LACUNA: DOC-06 não detalha a atribuição quando o
   * conteúdo do volume é uma FRAÇÃO do que foi pesado no picking (várias
   * tarefas/volumes do mesmo item) — adotado peso médio por unidade
   * (Σ peso apurado / Σ qty_confirmed das tarefas do item), multiplicado
   * pela quantidade deste volume; documentado, não inventado em silêncio.]
   */
  private async computeTheoreticalWeight(client: PoolClient, pkg: any): Promise<number> {
    const linesResult = await client.query(
      `SELECT pc.qty, p.id AS product_id, p.gross_weight_kg, p.is_weight_variable, pc.outbound_order_item_id
       FROM wms.package_content pc JOIN wms.product p ON p.id = pc.product_id
       WHERE pc.package_id = $1`,
      [pkg.id]
    );

    let total = Number(pkg.tare_kg);
    for (const line of linesResult.rows) {
      const qty = Number(line.qty);
      if (line.is_weight_variable) {
        const capturedResult = await client.query(
          `SELECT COALESCE(SUM(weight_kg), 0) AS total_weight, COALESCE(SUM(qty_confirmed), 0) AS total_qty
           FROM wms.picking_task WHERE outbound_order_item_id = $1 AND weight_kg IS NOT NULL`,
          [line.outbound_order_item_id]
        );
        const captured = capturedResult.rows[0];
        const capturedQty = Number(captured.total_qty);
        const unitWeight = capturedQty > 0 ? Number(captured.total_weight) / capturedQty : Number(line.gross_weight_kg ?? 0);
        total += qty * unitWeight;
      } else {
        total += qty * Number(line.gross_weight_kg ?? 0);
      }
    }
    return total;
  }

  /**
   * RF-EXP-050/RN-EXP-051 [INVIOLÁVEL] — pesagem do volume. Dentro da
   * tolerância: WEIGHED. Fora: abre EXP.DIVERGENCIA_PESO e bloqueia a etapa
   * PESAGEM (flow_step.blocking_exception_id) até decisão.
   */
  async weighPackage(input: WeighPackageInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const pkg = await this.loadPackage(input.packageId, ctx);
    if (pkg.status !== 'CLOSED') {
      throw new ConflictException({ error: 'PACKAGE_NOT_CLOSED', detail: `RF-EXP-050: volume ${input.packageId} não está CLOSED (status atual: ${pkg.status})` });
    }
    if (input.source === 'MANUAL') {
      const hasPermission = await this.rbacService.hasPermission(input.actorUserId, 'EXP.PESO_MANUAL', { warehouseId: input.warehouseId, clientId: input.tenantId });
      if (!hasPermission) throw new ForbiddenException({ error: 'MANUAL_WEIGHT_PERMISSION_REQUIRED', detail: 'RF-EXP-050: peso manual exige EXP.PESO_MANUAL' });
      if (!input.reasonText) throw new BadRequestException({ error: 'MANUAL_WEIGHT_REASON_REQUIRED', detail: 'RF-EXP-050: peso manual exige motivo (balança indisponível)' });
    }

    const tolerancePct = await this.resolveTolerancePct(ctx);
    const evaluation = evaluateWeightTolerance({ theoreticalKg: Number(pkg.theoretical_weight_kg), tolerancePct, readKg: input.weightKg });

    const result = await this.db.transaction(ctx, async (client) => {
      if (evaluation.approved) {
        const updated = await client.query(
          `UPDATE wms.package SET status = 'WEIGHED', actual_weight_kg = $2, weight_source = $3, weight_reason_text = $4, weighed_at = now(), updated_at = now(), updated_by = $5
           WHERE id = $1 RETURNING *`,
          [input.packageId, input.weightKg, input.source, input.reasonText ?? null, input.actorUserId]
        );
        await this.eventsService.publishInTransaction(client, {
          event_type: 'expedicao.volume_pesado',
          tenant_id: input.tenantId,
          warehouse_id: input.warehouseId,
          actor_user_id: input.actorUserId,
          payload: { package_id: input.packageId, outbound_order_id: pkg.outbound_order_id, weight_kg: input.weightKg, approved: true },
        });
        await this.tryCompleteWeighingStep(client, pkg.outbound_order_id, input.tenantId, input.warehouseId, input.actorUserId);
        return updated.rows[0];
      }

      const exception = await this.operationalExceptionService.create({
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        exceptionType: 'EXP.DIVERGENCIA_PESO',
        entity: 'package',
        entityId: input.packageId,
        valueBrl: undefined,
        reasonRequest: `RN-EXP-051: peso lido ${input.weightKg}kg fora da faixa ${evaluation.lowerBoundKg}-${evaluation.upperBoundKg}kg`,
        requestedBy: input.actorUserId,
      });

      const updated = await client.query(
        `UPDATE wms.package SET status = 'WEIGHT_DIVERGENT', actual_weight_kg = $2, weight_source = $3, weight_reason_text = $4, weight_exception_id = $5, updated_at = now(), updated_by = $6
         WHERE id = $1 RETURNING *`,
        [input.packageId, input.weightKg, input.source, input.reasonText ?? null, exception.id, input.actorUserId]
      );

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1`, [pkg.outbound_order_id]);
      await this.operationFlowService.linkBlockingException(client, flowResult.rows[0].id, 'PESAGEM', exception.id, input.actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.divergencia_peso',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: {
          package_id: input.packageId,
          outbound_order_id: pkg.outbound_order_id,
          weight_kg: input.weightKg,
          lower_bound_kg: evaluation.lowerBoundKg,
          upper_bound_kg: evaluation.upperBoundKg,
        },
      });

      return updated.rows[0];
    });

    return result;
  }

  /**
   * RN-EXP-051 — decisão da exceção EXP.DIVERGENCIA_PESO (já APROVADA, 1
   * passo): aceitar o lido (motivo) OU devolver ao packing (estorno da
   * volumação DESTE volume específico — LPN cancelado, conteúdo desmarcado
   * da soma da etapa Embalagem).
   */
  async decideWeightDivergence(packageId: string, decision: 'ACCEPT' | 'RETURN_TO_PACKING', reason: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const hasPermission = await this.rbacService.hasPermission(actorUserId, 'EXP.ONDA_GERIR', { warehouseId, clientId: tenantId });
    if (!hasPermission) throw new ForbiddenException({ error: 'WEIGHT_DECISION_PERMISSION_REQUIRED', detail: 'RN-EXP-051: decisão de divergência exige EXP.ONDA_GERIR (líder de turno)' });

    const pkg = await this.loadPackage(packageId, ctx);
    if (pkg.status !== 'WEIGHT_DIVERGENT' || !pkg.weight_exception_id) {
      throw new ConflictException({ error: 'PACKAGE_NOT_DIVERGENT', detail: `RN-EXP-051: volume ${packageId} não tem divergência pendente` });
    }
    const exceptionResult = await this.db.query(ctx, `SELECT status FROM wms.operational_exception WHERE id = $1`, [pkg.weight_exception_id]);
    if (exceptionResult.rows[0]?.status !== 'APPROVED') {
      throw new ConflictException({ error: 'EXCEPTION_NOT_APPROVED', detail: 'RN-EXP-051: EXP.DIVERGENCIA_PESO precisa estar APROVADA' });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      let updated;
      if (decision === 'ACCEPT') {
        updated = await client.query(
          `UPDATE wms.package SET status = 'WEIGHED', weighed_at = now(), weight_reason_text = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
          [packageId, reason, actorUserId]
        );
      } else {
        // Estorno da volumação DESTE volume: LPN cancelado; o conteúdo
        // deixa de contar na soma da etapa Embalagem (status != CLOSED/WEIGHED).
        updated = await client.query(`UPDATE wms.package SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`, [
          packageId,
          actorUserId,
        ]);
      }

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1`, [pkg.outbound_order_id]);
      await this.operationFlowService.clearBlockingException(client, flowResult.rows[0].id, 'PESAGEM', actorUserId);

      if (decision === 'ACCEPT') {
        await this.tryCompleteWeighingStep(client, pkg.outbound_order_id, tenantId, warehouseId, actorUserId);
      }

      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'package',
      entityId: packageId,
      action: 'OVERRIDE',
      requirementId: 'DOC-06 RN-EXP-051',
      reason,
      after: result,
    });

    return result;
  }

  /**
   * RF-EXP-040 — tenta concluir a etapa Embalagem: conteúdo total declarado
   * (em volumes CLOSED/WEIGHED — CANCELLED não conta) = separado, item a
   * item, "nem mais, nem menos".
   */
  async attemptCompletePackingStep(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const diffResult = await this.db.query(
      ctx,
      `SELECT i.id AS item_id, i.product_id, i.qty_picked, COALESCE(SUM(pc.qty), 0) AS declared
       FROM wms.outbound_order_item i
       LEFT JOIN wms.package_content pc ON pc.outbound_order_item_id = i.id
         AND pc.package_id IN (SELECT id FROM wms.package WHERE outbound_order_id = $1 AND status IN ('CLOSED', 'WEIGHED', 'LOADED'))
       WHERE i.outbound_order_id = $1 AND i.moved_to_order_id IS NULL
       GROUP BY i.id, i.product_id, i.qty_picked`,
      [orderId]
    );

    const differences = diffResult.rows
      .map((row) => ({ productId: row.product_id, expected: Number(row.qty_picked), declared: Number(row.declared), diff: Number(row.declared) - Number(row.qty_picked) }))
      .filter((d) => d.diff !== 0);

    if (differences.length > 0) {
      return { completed: false, differences };
    }

    const completed = await this.db.transaction(ctx, async (client) => {
      if (!(await isFirstPendingStep(client, orderId, 'EMBALAGEM'))) return false;

      await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'EMBALAGEM' }, actorUserId);
      return true;
    });

    return { completed, differences: [] };
  }

  private async tryCompleteWeighingStep(client: PoolClient, orderId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<void> {
    const pendingResult = await client.query(
      `SELECT COUNT(*) AS count FROM wms.package WHERE outbound_order_id = $1 AND status NOT IN ('WEIGHED', 'CANCELLED')`,
      [orderId]
    );
    if (Number(pendingResult.rows[0].count) > 0) return;

    const cancelledOnlyCheck = await client.query(`SELECT COUNT(*) AS count FROM wms.package WHERE outbound_order_id = $1 AND status = 'WEIGHED'`, [orderId]);
    if (Number(cancelledOnlyCheck.rows[0].count) === 0) return; // nenhum volume pesado ainda

    // A etapa só pode concluir quando é de fato a PRIMEIRA pendente (RG-002)
    // — não basta o PRÓPRIO flow_step estar PENDING (ele fica PENDING até
    // ser concluído, independente de etapas ANTERIORES já terem concluído).
    if (!(await isFirstPendingStep(client, orderId, 'PESAGEM'))) return;

    await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'PESAGEM' }, actorUserId);
  }

  private async resolveTolerancePct(ctx: TenantContext): Promise<number> {
    const result = await this.db.query(ctx, `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.TOLERANCIA_PESO_PCT'`, []);
    const value = result.rows[0]?.value;
    const parsed = value === undefined ? NaN : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOLERANCE_PCT;
  }

  private async loadPackage(packageId: string, ctx: TenantContext) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.package WHERE id = $1`, [packageId]);
    const pkg = result.rows[0];
    if (!pkg) throw new NotFoundException(`package ${packageId} not found`);
    return pkg;
  }
}
