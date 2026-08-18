-- Migration: 0047
-- DOC-05 §4.5 — Entregável 5: RF-EST-040 (estoque de segurança), RF-EST-041
-- (kanban) e RF-EST-042 (reposição de picking, tarefa dirigida com dupla
-- leitura "como no putaway", RF-REC-042).

-- =============================================================================
-- 1. RF-EST-040 — dedup "uma notificação por cruzamento de limiar, não por
-- movimentação". Coluna na PRÓPRIA wms.product_warehouse_parameter (já tem 1
-- linha por tenant×produto×armazém, migration 0011) em vez de tabela nova:
-- guarda se o alerta ESTÁ ativo (disponível_total < safety_stock_qty);
-- SafetyStockService só publica evento na TRANSIÇÃO false->true, e reseta
-- (sem publicar) quando o saldo volta a ficar >= safety_stock_qty.
-- =============================================================================
ALTER TABLE wms.product_warehouse_parameter ADD COLUMN IF NOT EXISTS safety_stock_alert_active BOOLEAN NOT NULL DEFAULT FALSE;

-- =============================================================================
-- 2. RD-EST-002 — wms.replenishment_task (TENANT, RLS, particionada
-- mensalmente "como task", RNF-ARQ-090 — mesmo padrão de wms.putaway_task,
-- migration 0039). Diferença de desenho em relação a putaway_task: origem E
-- destino já são conhecidos na CRIAÇÃO (não só no ASSIGN) — RF-EST-041 exige
-- que a origem já seja escolhida pela política de giro do produto no
-- instante da geração da tarefa (RN-EST-011, [DÉBITO: 5B] — esta sessão usa
-- heurística provisória, ver ReplenishmentService).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.replenishment_task (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  trigger_type TEXT NOT NULL,
  location_id_origin UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  location_id_destination UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  assigned_to_user_id UUID,
  assigned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  PRIMARY KEY (id, created_at),
  CONSTRAINT replenishment_task_trigger_type_check CHECK (trigger_type IN ('KANBAN', 'MANUAL', 'DEMANDA')),
  CONSTRAINT replenishment_task_qty_check CHECK (qty > 0),
  -- §5.2 (reaproveitando a máquina de estados de putaway_task, "dirigida com
  -- dupla leitura como no putaway", RF-EST-042): CREATED -> ASSIGNED ->
  -- IN_EXECUTION -> DONE; CANCELLED e REJECTED_SCAN são ramos.
  CONSTRAINT replenishment_task_status_check CHECK (status IN (
    'CREATED', 'ASSIGNED', 'IN_EXECUTION', 'DONE', 'CANCELLED', 'REJECTED_SCAN'
  ))
) PARTITION BY RANGE (created_at);

-- Mesmo padrão de wms.ensure_putaway_task_partition (migration 0039):
-- SECURITY DEFINER porque wms_app/wms_worker só têm USAGE no schema, não CREATE.
CREATE OR REPLACE FUNCTION wms.ensure_replenishment_task_partition(p_year INT, p_month INT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wms, pg_temp
AS $$
DECLARE
  v_partition_name TEXT;
  v_start DATE;
  v_end DATE;
BEGIN
  v_partition_name := format('replenishment_task_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.replenishment_task FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON wms.%I TO wms_app', v_partition_name);
    -- RF-EST-041: a GERAÇÃO da tarefa roda no job horário do scheduler
    -- (wms_worker, transactionAsWorker) — mesmo motivo já documentado na
    -- migration 0046 para stock_movement.
    EXECUTE format('GRANT SELECT, INSERT ON wms.%I TO wms_worker', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

DO $$
DECLARE
  v_now DATE := CURRENT_DATE;
  v_next DATE := (CURRENT_DATE + INTERVAL '1 month')::date;
BEGIN
  PERFORM wms.ensure_replenishment_task_partition(EXTRACT(YEAR FROM v_now)::int, EXTRACT(MONTH FROM v_now)::int);
  PERFORM wms.ensure_replenishment_task_partition(EXTRACT(YEAR FROM v_next)::int, EXTRACT(MONTH FROM v_next)::int);
END
$$;

CREATE INDEX IF NOT EXISTS idx_replenishment_task_warehouse_status ON wms.replenishment_task (warehouse_id, status);
-- RF-EST-041: "PROIBIDO gerar nova tarefa kanban enquanto houver reposição
-- aberta do mesmo produto×endereço" — índice para a checagem de duplicidade.
CREATE INDEX IF NOT EXISTS idx_replenishment_task_product_destination ON wms.replenishment_task (product_id, location_id_destination, status);

ALTER TABLE wms.replenishment_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.replenishment_task FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS replenishment_task_tenant_isolation ON wms.replenishment_task;
CREATE POLICY replenishment_task_tenant_isolation ON wms.replenishment_task
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.replenishment_task TO wms_app;
-- RF-EST-041: KanbanService.checkKanban() faz `INSERT INTO wms.replenishment_task`
-- (via ReplenishmentTaskService.generateIfNeeded) rodando como wms_worker
-- (transactionAsWorker) — o ACL de INSERT/SELECT numa tabela PARTICIONADA é
-- checado contra a relação NOMEADA no comando (o pai), não só a partição de
-- destino (mesmo motivo já corrigido para wms.stock_movement na migration
-- 0046: grant no pai É necessário além do grant por partição).
GRANT SELECT, INSERT ON wms.replenishment_task TO wms_worker;

-- =============================================================================
-- 3. wms.replenishment_operation — idempotência da confirmação (RNF-ARQ-050),
-- mesmo motivo/desenho de wms.putaway_operation (migration 0043): tabela
-- própria (não coluna em replenishment_task, que é particionada — UNIQUE
-- teria que incluir a chave de partição e perderia unicidade GLOBAL).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.replenishment_operation (
  operation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  replenishment_task_id UUID NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replenishment_operation_task ON wms.replenishment_operation (replenishment_task_id);

ALTER TABLE wms.replenishment_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.replenishment_operation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS replenishment_operation_tenant_isolation ON wms.replenishment_operation;
CREATE POLICY replenishment_operation_tenant_isolation ON wms.replenishment_operation
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.replenishment_operation TO wms_app;

-- =============================================================================
-- 4. Grants ADR-006/wms_worker — RF-EST-040/041 rodam cross-tenant via
-- transactionAsWorker no job horário do scheduler (mesmo padrão já usado
-- para RN-EST-014, migration 0046).
-- =============================================================================
GRANT SELECT, UPDATE ON wms.product_warehouse_parameter TO wms_worker;
GRANT SELECT ON wms.location TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (47, 'DOC-05 RF-EST-040/041/042: safety_stock_alert_active + wms.replenishment_task/replenishment_operation (RD-EST-002) + grants wms_worker', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
