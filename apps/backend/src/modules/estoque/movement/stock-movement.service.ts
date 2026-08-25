// DOC-05 §4.1 RN-EST-001 [INVIOLÁVEL] — "um único serviço de movimentação
// deve ser o ÚNICO caminho para alterar stock_balance; nenhum módulo escreve
// saldo diretamente". A proibição é POR CONSTRUÇÃO: o trigger
// wms.guard_stock_balance_direct_write (migration 0045) rejeita qualquer
// INSERT/UPDATE em wms.stock_balance que não passe primeiro por
// `apply()`/`applyStandalone()` abaixo, que são os únicos pontos deste
// código-fonte que executam `set_config('app.stock_movement_authorized', ...)`.
//
// A regra de efeito (qual parcela debita/credita por movement_type) é pura e
// vive em stock-movement-effects.util.ts — aqui só entra I/O: validação de
// RG-004 no nível da app (WHERE qty_bucket >= $qty na própria UPDATE, não
// apenas o CHECK do banco como primeira linha de defesa) e a escrita
// (sempre em par) de wms.stock_balance + wms.stock_movement.
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { BUCKET_COLUMN, MovementType, StockBucket, isSameBucketLocationMove, resolveMovementBucketEffect } from './stock-movement-effects.util.js';

export interface ApplyMovementParams {
  tenantId: string;
  /** Armazém principal — ORIGEM para TRANSFERENCIA_ENTRADA_ARMAZEM, único armazém para os demais tipos. */
  warehouseId: string;
  /** Só para TRANSFERENCIA_ENTRADA_ARMAZEM: armazém DESTINO, onde o crédito ocorre. */
  destinationWarehouseId?: string;
  movementType: MovementType;
  productId: string;
  batchId?: string | null;
  qty: number;
  locationIdFrom?: string | null;
  palletIdFrom?: string | null;
  locationIdTo?: string | null;
  palletIdTo?: string | null;
  bucketFromOverride?: StockBucket;
  bucketToOverride?: StockBucket;
  documentRefType?: string | null;
  documentRefId?: string | null;
  taskId?: string | null;
  /** wms.stock_movement.requirement_id é UUID (migration 0014) — NUNCA uma citação textual de requisito (ex.: "DOC-04 RF-REC-042"); usar apenas um id real (ex.: id do documento/exceção causadora) ou omitir. */
  requirementId?: string | null;
  policyBreak?: boolean;
  breakReason?: string | null;
  /** RF-EST-030: motivo tipificado (RD-EST-004) — só para BLOQUEIO/DESBLOQUEIO. */
  blockReasonCode?: string | null;
  blockReasonText?: string | null;
  /**
   * DOC-17 RD-TEL-004 — canal que originou a movimentação:
   * `COLETOR` (padrão, DOC-15), `TELA` (§6) ou `FORMULARIO` (§8).
   * Alimenta o indicador de acuracidade por modo recomendado no DOC-17 §13.
   * `stock_movement` é append-only: o valor gravado aqui é definitivo.
   */
  executionChannel?: 'COLETOR' | 'TELA' | 'FORMULARIO';
  actorUserId: string;
}

export interface StockMovementRecord {
  movementIds: string[];
  movementType: MovementType;
  bucketFrom: StockBucket | null;
  bucketTo: StockBucket | null;
  qty: number;
}

@Injectable()
export class StockMovementService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (mesmo padrão do resto do módulo).
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Conveniência para chamadores que ainda não têm uma transação aberta. */
  async applyStandalone(ctx: TenantContext, params: ApplyMovementParams): Promise<StockMovementRecord> {
    return this.db.transaction(ctx, (client) => this.apply(client, params));
  }

  /**
   * RN-EST-001 — único caminho para alterar wms.stock_balance. `client` deve
   * ser um PoolClient de uma transação já aberta (mesmo contrato de
   * EventsService.publishInTransaction) para que a escrita de saldo, o
   * registro em stock_movement e qualquer outra mutação da mesma operação
   * de negócio (ex.: status de uma tarefa) sejam atômicos.
   */
  async apply(client: PoolClient, params: ApplyMovementParams): Promise<StockMovementRecord> {
    if (params.qty <= 0) {
      throw new BadRequestException({ error: 'INVALID_QTY', detail: `RG-010: qty deve ser positivo (recebido ${params.qty})` });
    }

    // Autorização "por construção" (migration 0045) — LOCAL ao transaction
    // block atual (expira sozinho no COMMIT/ROLLBACK), mesmo padrão de
    // app.tenant_ids/app.user_id em DatabaseService.
    await client.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);

    const effect = resolveMovementBucketEffect(params.movementType, {
      bucketFrom: params.bucketFromOverride,
      bucketTo: params.bucketToOverride,
    });

    const movementIds: string[] = [];

    if (params.movementType === 'TRANSFERENCIA_ENTRADA_ARMAZEM') {
      if (!params.destinationWarehouseId) {
        throw new BadRequestException({
          error: 'MISSING_DESTINATION_WAREHOUSE',
          detail: 'RF-EST-051: TRANSFERENCIA_ENTRADA_ARMAZEM exige destinationWarehouseId',
        });
      }
      // Débito do in_transit represado na ORIGEM (RF-EST-051).
      await this.debit(client, {
        tenantId: params.tenantId,
        warehouseId: params.warehouseId,
        productId: params.productId,
        batchId: params.batchId ?? null,
        locationId: params.locationIdFrom ?? null,
        palletId: params.palletIdFrom ?? null,
        bucket: effect.bucketFrom as StockBucket,
        qty: params.qty,
        actorUserId: params.actorUserId,
      });
      const originMovementId = await this.insertMovementRow(client, params, {
        warehouseId: params.warehouseId,
        locationIdFrom: params.locationIdFrom ?? null,
        palletIdFrom: params.palletIdFrom ?? null,
        bucketFrom: effect.bucketFrom,
        locationIdTo: null,
        palletIdTo: null,
        bucketTo: null,
      });
      movementIds.push(originMovementId);

      // Crédito no DESTINO.
      await this.credit(client, {
        tenantId: params.tenantId,
        warehouseId: params.destinationWarehouseId,
        productId: params.productId,
        batchId: params.batchId ?? null,
        locationId: params.locationIdTo ?? null,
        palletId: params.palletIdTo ?? null,
        bucket: effect.bucketTo as StockBucket,
        qty: params.qty,
        actorUserId: params.actorUserId,
      });
      const destMovementId = await this.insertMovementRow(client, params, {
        warehouseId: params.destinationWarehouseId,
        locationIdFrom: null,
        palletIdFrom: null,
        bucketFrom: null,
        locationIdTo: params.locationIdTo ?? null,
        palletIdTo: params.palletIdTo ?? null,
        bucketTo: effect.bucketTo,
      });
      movementIds.push(destMovementId);

      return { movementIds, movementType: params.movementType, bucketFrom: effect.bucketFrom, bucketTo: effect.bucketTo, qty: params.qty };
    }

    // Caso geral: um único armazém. Débito (se houver) e crédito (se
    // houver) do MESMO movimento, uma única linha de stock_movement.
    //
    // PUTAWAY/TRANSFERENCIA_INTERNA/REPOSICAO são "mesma parcela, move de
    // endereço" — MAS só há débito de fato quando o chamador informa uma
    // origem (locationIdFrom/palletIdFrom). Sem origem, é a PRIMEIRA vez que
    // o conteúdo entra no saldo endereçável (ex.: putaway logo após a
    // conferência, DOC-04 RF-REC-042 — nenhum módulo credita um saldo de
    // "doca"/staging antes disso hoje) e o efeito real é um crédito puro no
    // destino, preservando o movement_type documental (RN-EST-001) mesmo
    // sem um débito para casar. [LACUNA: DOC-05 não distingue "putaway após
    // staging" de "putaway como primeira entrada no saldo" — inferência
    // desta sessão, compatível com o fluxo já testado do DOC-04.]
    const isLocationMove = isSameBucketLocationMove(params.movementType);
    const hasOrigin = Boolean(params.locationIdFrom || params.palletIdFrom);
    const shouldDebit = effect.bucketFrom !== null && (!isLocationMove || hasOrigin);

    if (shouldDebit) {
      await this.debit(client, {
        tenantId: params.tenantId,
        warehouseId: params.warehouseId,
        productId: params.productId,
        batchId: params.batchId ?? null,
        locationId: params.locationIdFrom ?? null,
        palletId: params.palletIdFrom ?? null,
        bucket: effect.bucketFrom as StockBucket,
        qty: params.qty,
        actorUserId: params.actorUserId,
      });
    }
    if (effect.bucketTo) {
      const creditLocationId = isLocationMove ? (params.locationIdTo ?? null) : (params.locationIdTo ?? params.locationIdFrom ?? null);
      const creditPalletId = isLocationMove ? (params.palletIdTo ?? null) : (params.palletIdTo ?? params.palletIdFrom ?? null);
      await this.credit(client, {
        tenantId: params.tenantId,
        warehouseId: params.warehouseId,
        productId: params.productId,
        batchId: params.batchId ?? null,
        locationId: creditLocationId,
        palletId: creditPalletId,
        bucket: effect.bucketTo,
        qty: params.qty,
        actorUserId: params.actorUserId,
      });
    }

    const movementId = await this.insertMovementRow(client, params, {
      warehouseId: params.warehouseId,
      locationIdFrom: shouldDebit ? (params.locationIdFrom ?? null) : null,
      palletIdFrom: shouldDebit ? (params.palletIdFrom ?? null) : null,
      bucketFrom: shouldDebit ? effect.bucketFrom : null,
      locationIdTo: effect.bucketTo ? (params.locationIdTo ?? params.locationIdFrom ?? null) : null,
      palletIdTo: effect.bucketTo ? (params.palletIdTo ?? params.palletIdFrom ?? null) : null,
      bucketTo: effect.bucketTo,
    });
    movementIds.push(movementId);

    return { movementIds, movementType: params.movementType, bucketFrom: shouldDebit ? effect.bucketFrom : null, bucketTo: effect.bucketTo, qty: params.qty };
  }

  /** RG-004 [INVIOLÁVEL] revalidado no nível da app: a UPDATE só afeta linha se houver saldo suficiente; 0 linhas = saldo insuficiente. */
  private async debit(
    client: PoolClient,
    args: { tenantId: string; warehouseId: string; productId: string; batchId: string | null; locationId: string | null; palletId: string | null; bucket: StockBucket; qty: number; actorUserId: string }
  ): Promise<void> {
    const column = BUCKET_COLUMN[args.bucket];
    const result = await client.query(
      `UPDATE wms.stock_balance
       SET ${column} = ${column} - $1, updated_at = now(), updated_by = $2
       WHERE tenant_id = $3 AND warehouse_id = $4 AND product_id = $5
         AND batch_id IS NOT DISTINCT FROM $6 AND location_id IS NOT DISTINCT FROM $7 AND pallet_id IS NOT DISTINCT FROM $8
         AND ${column} >= $1
       RETURNING id`,
      [args.qty, args.actorUserId, args.tenantId, args.warehouseId, args.productId, args.batchId, args.locationId, args.palletId]
    );
    if (result.rowCount === 0) {
      throw new BadRequestException({
        error: 'INSUFFICIENT_BALANCE',
        detail: `RG-004 [INVIOLAVEL]: saldo insuficiente em ${args.bucket} para debitar ${args.qty} (produto ${args.productId}, endereco ${args.locationId ?? 'null'})`,
      });
    }
  }

  private async credit(
    client: PoolClient,
    args: { tenantId: string; warehouseId: string; productId: string; batchId: string | null; locationId: string | null; palletId: string | null; bucket: StockBucket; qty: number; actorUserId: string }
  ): Promise<void> {
    const column = BUCKET_COLUMN[args.bucket];
    await client.query(
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id, ${column}, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id)
       DO UPDATE SET ${column} = wms.stock_balance.${column} + EXCLUDED.${column}, updated_at = now(), updated_by = $8`,
      [args.tenantId, args.warehouseId, args.productId, args.batchId, args.locationId, args.palletId, args.qty, args.actorUserId]
    );
  }

  private async insertMovementRow(
    client: PoolClient,
    params: ApplyMovementParams,
    row: {
      warehouseId: string;
      locationIdFrom: string | null;
      palletIdFrom: string | null;
      bucketFrom: StockBucket | null;
      locationIdTo: string | null;
      palletIdTo: string | null;
      bucketTo: StockBucket | null;
    }
  ): Promise<string> {
    const result = await client.query(
      `INSERT INTO wms.stock_movement (
         tenant_id, warehouse_id, movement_type, product_id, batch_id,
         location_id_from, location_id_to, pallet_id_from, pallet_id_to,
         balance_bucket_from, balance_bucket_to, qty,
         document_ref_type, document_ref_id, task_id, requirement_id,
         policy_break, break_reason, block_reason_code, block_reason_text, execution_channel, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [
        params.tenantId,
        row.warehouseId,
        params.movementType,
        params.productId,
        params.batchId ?? null,
        row.locationIdFrom,
        row.locationIdTo,
        row.palletIdFrom,
        row.palletIdTo,
        row.bucketFrom,
        row.bucketTo,
        params.qty,
        params.documentRefType ?? null,
        params.documentRefId ?? null,
        params.taskId ?? null,
        params.requirementId ?? null,
        params.policyBreak ?? false,
        params.breakReason ?? null,
        params.blockReasonCode ?? null,
        params.blockReasonText ?? null,
        params.executionChannel ?? 'COLETOR', // DOC-17 RD-TEL-004
        params.actorUserId,
      ]
    );
    return result.rows[0].id;
  }
}
