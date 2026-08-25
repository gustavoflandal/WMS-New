// DOC-17 RF-TEL-003 — catálogo fechado de conteúdo por etapa. Leitura pura
// (SQL direto contra as tabelas de cada módulo, sem invocar services de
// escrita — ver docs/PROMPT-SESSAO-10A-doc17-detalhe-etapa.md decisão 2).
// Cada resolver recebe o client de tenant já configurado (via DatabaseService)
// e devolve um objeto plano — o formato exato de cada um segue a coluna
// "Detalhe exibido" da tabela RF-TEL-003.
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';

export type StepContentResolver = (db: DatabaseService, ctx: TenantContext, entityId: string, hideExecutors: boolean) => Promise<Record<string, unknown>>;

function omitExecutor<T extends Record<string, unknown>>(row: T, hideExecutors: boolean, fields: (keyof T)[]): T {
  if (!hideExecutors) return row;
  const copy = { ...row };
  for (const f of fields) (copy as any)[f] = undefined;
  return copy;
}

/** Chegada/Doca/Descarga — comum a inbound_order e return_order (ambos via vehicle_visit/dock do DOC-03). */
async function vehicleVisitContent(db: DatabaseService, ctx: TenantContext, vehicleVisitId: string | null, dockId: string | null, hideExecutors: boolean) {
  if (!vehicleVisitId) return { vehicle_visit: null, dock: null };
  const visitResult = await db.query(
    ctx,
    `SELECT vv.status, vv.gate_in_at, vv.dock_at, vv.gate_out_at, vv.seals_in, vv.km, vv.contains_hazmat, vv.contains_perishable,
            v.plate, d.name AS driver_name
     FROM wms.vehicle_visit vv
     JOIN wms.vehicle v ON v.id = vv.vehicle_id
     JOIN wms.driver d ON d.id = vv.driver_id
     WHERE vv.id = $1`,
    [vehicleVisitId]
  );
  const visit = visitResult.rows[0] ?? null;
  const dockResult = dockId ? await db.queryGlobal(`SELECT code, dock_type FROM wms.dock WHERE id = $1`, [dockId]) : { rows: [] };
  return {
    vehicle_visit: visit ? omitExecutor(visit, hideExecutors, ['driver_name']) : null,
    dock: dockResult.rows[0] ?? null,
  };
}

// ── inbound_order ───────────────────────────────────────────────────────
const inboundOrderResolvers: Record<string, StepContentResolver> = {
  CHEGADA: async (db, ctx, entityId, hideExecutors) => {
    const order = await db.query(ctx, `SELECT vehicle_visit_id, dock_id, origin FROM wms.inbound_order WHERE id = $1`, [entityId]);
    return vehicleVisitContent(db, ctx, order.rows[0]?.vehicle_visit_id ?? null, null, hideExecutors);
  },
  DOCA: async (db, ctx, entityId, hideExecutors) => {
    const order = await db.query(ctx, `SELECT vehicle_visit_id, dock_id FROM wms.inbound_order WHERE id = $1`, [entityId]);
    return vehicleVisitContent(db, ctx, order.rows[0]?.vehicle_visit_id ?? null, order.rows[0]?.dock_id ?? null, hideExecutors);
  },
  DESCARGA: async (db, ctx, entityId, hideExecutors) => {
    const order = await db.query(ctx, `SELECT vehicle_visit_id, dock_id FROM wms.inbound_order WHERE id = $1`, [entityId]);
    return vehicleVisitContent(db, ctx, order.rows[0]?.vehicle_visit_id ?? null, order.rows[0]?.dock_id ?? null, hideExecutors);
  },
  CONFERENCIA: async (db, ctx, entityId, hideExecutors) => {
    const checking = await db.query(ctx, `SELECT id, mode, status, mode_switch_reason FROM wms.checking WHERE inbound_order_id = $1 ORDER BY created_at DESC LIMIT 1`, [entityId]);
    const header = checking.rows[0];
    if (!header) return { checking: null, items: [] };
    const items = await db.query(
      ctx,
      `SELECT ci.round, ci.qty_counted, ci.counted_at, ioi.product_id, ci.conferente_user_id
       FROM wms.checking_item ci
       JOIN wms.inbound_order_item ioi ON ioi.id = ci.inbound_order_item_id
       WHERE ci.checking_id = $1 ORDER BY ioi.id, ci.round`,
      [header.id]
    );
    return {
      checking: header,
      items: items.rows.map((r: any) => omitExecutor(r, hideExecutors, ['conferente_user_id'])),
    };
  },
  DIVERGENCIAS: async (db, ctx, entityId, hideExecutors) => {
    const items = await db.query(
      ctx,
      `SELECT d.discrepancy_type, d.qty, d.photo_keys, d.status, d.resolution, d.created_at, d.created_by
       FROM wms.discrepancy d
       JOIN wms.inbound_order_item ioi ON ioi.id = d.inbound_order_item_id
       WHERE ioi.inbound_order_id = $1 ORDER BY d.created_at`,
      [entityId]
    );
    return { discrepancies: items.rows.map((r: any) => omitExecutor(r, hideExecutors, ['created_by'])) };
  },
  ETIQUETAGEM: async (db, ctx, entityId, hideExecutors) => {
    const pallets = await db.query(
      ctx,
      `SELECT p.id, p.lpn, p.status, p.current_location_id, p.created_at, p.created_by
       FROM wms.pallet p WHERE p.inbound_order_id = $1 ORDER BY p.created_at`,
      [entityId]
    );
    const jobs = await db.queryGlobal(
      `SELECT print_entity_id, state, reprint_seq FROM wms.peripheral_job WHERE print_entity = 'pallet' AND print_entity_id = ANY($1::uuid[])`,
      [pallets.rows.map((p: any) => p.id)]
    );
    return {
      pallets: pallets.rows.map((r: any) => omitExecutor(r, hideExecutors, ['created_by'])),
      print_jobs: jobs.rows,
    };
  },
  PUTAWAY: async (db, ctx, entityId, hideExecutors) => {
    const tasks = await db.query(
      ctx,
      `SELECT pt.id, pt.pallet_id, pt.location_id_designated, pt.location_id_executed, pt.override_reason, pt.status,
              pt.assigned_to_user_id, pt.started_at, pt.completed_at
       FROM wms.putaway_task pt WHERE pt.inbound_order_id = $1 ORDER BY pt.created_at`,
      [entityId]
    );
    return { tasks: tasks.rows.map((r: any) => omitExecutor(r, hideExecutors, ['assigned_to_user_id'])) };
  },
};

// ── outbound_order ──────────────────────────────────────────────────────
const outboundOrderResolvers: Record<string, StepContentResolver> = {
  PEDIDO: async (db, ctx, entityId) => {
    const order = await db.query(ctx, `SELECT number, status, recipient_name, recipient_document, expected_dispatch_date, wave_id FROM wms.outbound_order WHERE id = $1`, [entityId]);
    const items = await db.query(
      ctx,
      `SELECT product_id, qty_ordered, qty_reserved, qty_picked, qty_short, qty_packed FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND moved_to_order_id IS NULL ORDER BY line_number`,
      [entityId]
    );
    return { order: order.rows[0] ?? null, items: items.rows };
  },
  PICKING: async (db, ctx, entityId, hideExecutors) => {
    const tasks = await db.query(
      ctx,
      `SELECT id, product_id, batch_id, location_id_from, route_sequence, qty_suggested, qty_confirmed, qty_short,
              reason_code, reason_text, status, assigned_to_user_id, started_at, completed_at
       FROM wms.picking_task WHERE outbound_order_id = $1 ORDER BY route_sequence`,
      [entityId]
    );
    return { tasks: tasks.rows.map((r: any) => omitExecutor(r, hideExecutors, ['assigned_to_user_id'])) };
  },
  EMBALAGEM: async (db, ctx, entityId) => {
    const packages = await db.query(
      ctx,
      `SELECT id, lpn, package_type_code, tare_kg, sequence_number, status, staged_at FROM wms.package WHERE outbound_order_id = $1 ORDER BY sequence_number`,
      [entityId]
    );
    const contents = await db.query(
      ctx,
      `SELECT pc.package_id, pc.product_id, pc.batch_id, pc.qty FROM wms.package_content pc
       JOIN wms.package p ON p.id = pc.package_id WHERE p.outbound_order_id = $1`,
      [entityId]
    );
    return { packages: packages.rows, contents: contents.rows };
  },
  PESAGEM: async (db, ctx, entityId) => {
    const packages = await db.query(
      ctx,
      `SELECT id, lpn, theoretical_weight_kg, actual_weight_kg, weight_source, weight_reason_text, weighed_at, weight_exception_id
       FROM wms.package WHERE outbound_order_id = $1 ORDER BY sequence_number`,
      [entityId]
    );
    return { packages: packages.rows };
  },
  EXPEDICAO: async (db, ctx, entityId) => {
    const order = await db.query(
      ctx,
      `SELECT oo.fiscal_document_id, oo.fiscal_documents_authorized_at, oo.fiscal_rejection_detail,
              fd.document_type, fd.status AS fiscal_status, fd.access_key, fd.xml_storage_key
       FROM wms.outbound_order oo LEFT JOIN wms.fiscal_document fd ON fd.id = oo.fiscal_document_id
       WHERE oo.id = $1`,
      [entityId]
    );
    return { fiscal: order.rows[0] ?? null };
  },
  CARREGAMENTO: async (db, ctx, entityId) => {
    const loadingOrder = await db.query(
      ctx,
      `SELECT l.id, l.vehicle_visit_id, l.status, l.started_at, l.completed_at
       FROM wms.loading_order lo JOIN wms.loading l ON l.id = lo.loading_id
       WHERE lo.outbound_order_id = $1 ORDER BY l.created_at DESC LIMIT 1`,
      [entityId]
    );
    const loading = loadingOrder.rows[0];
    if (!loading) return { loading: null, scans: [] };
    const scans = await db.query(ctx, `SELECT scanned_lpn, result, rejection_detail, scanned_at FROM wms.loading_scan WHERE loading_id = $1 AND outbound_order_id = $2 ORDER BY scanned_at`, [
      loading.id,
      entityId,
    ]);
    return { loading, scans: scans.rows };
  },
  SAIDA: async (db, ctx, entityId) => {
    const loadingOrder = await db.query(
      ctx,
      `SELECT vv.status, vv.seals_out, vv.gate_out_at
       FROM wms.loading_order lo JOIN wms.loading l ON l.id = lo.loading_id JOIN wms.vehicle_visit vv ON vv.id = l.vehicle_visit_id
       WHERE lo.outbound_order_id = $1 ORDER BY l.created_at DESC LIMIT 1`,
      [entityId]
    );
    return { vehicle_visit: loadingOrder.rows[0] ?? null };
  },
};

// ── return_order ────────────────────────────────────────────────────────
const returnOrderResolvers: Record<string, StepContentResolver> = {
  CHEGADA: async (db, ctx, entityId, hideExecutors) => {
    const order = await db.query(ctx, `SELECT vehicle_visit_id, dock_id FROM wms.return_order WHERE id = $1`, [entityId]);
    return vehicleVisitContent(db, ctx, order.rows[0]?.vehicle_visit_id ?? null, null, hideExecutors);
  },
  DOCA: async (db, ctx, entityId, hideExecutors) => {
    const order = await db.query(ctx, `SELECT vehicle_visit_id, dock_id FROM wms.return_order WHERE id = $1`, [entityId]);
    return vehicleVisitContent(db, ctx, order.rows[0]?.vehicle_visit_id ?? null, order.rows[0]?.dock_id ?? null, hideExecutors);
  },
  DESCARGA: async (db, ctx, entityId, hideExecutors) => {
    const order = await db.query(ctx, `SELECT vehicle_visit_id, dock_id FROM wms.return_order WHERE id = $1`, [entityId]);
    return vehicleVisitContent(db, ctx, order.rows[0]?.vehicle_visit_id ?? null, order.rows[0]?.dock_id ?? null, hideExecutors);
  },
  TRIAGEM: async (db, ctx, entityId, hideExecutors) => {
    const records = await db.query(
      ctx,
      `SELECT product_id, batch_id, batch_provisional, qty, physical_state, photo_keys, disposition_suggested, created_by, created_at
       FROM wms.triage_record WHERE return_order_id = $1 ORDER BY created_at`,
      [entityId]
    );
    return { triage_records: records.rows.map((r: any) => omitExecutor(r, hideExecutors, ['created_by'])) };
  },
  DESTINACAO: async (db, ctx, entityId, hideExecutors) => {
    const records = await db.query(
      ctx,
      `SELECT product_id, qty, disposition_suggested, disposition_confirmed, confirmed_by, confirmed_at
       FROM wms.triage_record WHERE return_order_id = $1 ORDER BY created_at`,
      [entityId]
    );
    return { dispositions: records.rows.map((r: any) => omitExecutor(r, hideExecutors, ['confirmed_by'])) };
  },
};

// "Contagem (inventário)" (RF-TEL-003) NÃO está no dispatch abaixo: o
// inventário (DOC-05) ainda não abre `wms.operation_flow` — achado
// pré-existente, já documentado em `operations-board.service.ts` ("DOC-05
// não abre operation_flow ainda"), não uma lacuna desta sessão. Sem um
// `operation_flow` real para `inventory_count`, `getFlowState()` sempre
// lançaria `NotFoundException` antes de chegar a qualquer resolver — expor
// um resolver aqui seria código morto. `[DEBITO: 10A]` documentado no
// relatório: abrir `operation_flow` para inventário é pré-requisito de
// DOC-05, fora do escopo do DOC-17.

export const STEP_CONTENT_RESOLVERS: Record<string, Record<string, StepContentResolver>> = {
  inbound_order: inboundOrderResolvers,
  outbound_order: outboundOrderResolvers,
  return_order: returnOrderResolvers,
};
