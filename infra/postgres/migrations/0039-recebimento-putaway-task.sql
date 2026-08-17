-- Migration: 0039
-- DOC-04 RD-REC-005 — putaway_task (TENANT, RLS), particionada mensalmente
-- como `task` (RNF-ARQ-090). ESTRUTURA APENAS nesta sessão — a GERAÇÃO de
-- tarefas (motor de putaway, RN-REC-040/041/042) é [DÉBITO: Sessão 4B],
-- explicitamente fora de escopo desta sessão (4A). §5.2: CREATED -> ASSIGNED
-- -> IN_EXECUTION -> DONE; ramos CANCELLED e REJECTED_SCAN (volta a
-- ASSIGNED).

CREATE TABLE IF NOT EXISTS wms.putaway_task (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  pallet_id UUID NOT NULL REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  inbound_order_id UUID REFERENCES wms.inbound_order(id) ON DELETE RESTRICT,
  -- Designado pelo motor de putaway (Fase 1+2, RN-REC-040) — [DÉBITO: 4B].
  location_id_designated UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  assigned_to_user_id UUID,
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  PRIMARY KEY (id, created_at),
  -- §5.2: CREATED -> ASSIGNED -> IN_EXECUTION -> DONE; CANCELLED e
  -- REJECTED_SCAN (leitura de endereço divergente, RF-REC-042) são ramos.
  CONSTRAINT putaway_task_status_check CHECK (status IN (
    'CREATED', 'ASSIGNED', 'IN_EXECUTION', 'DONE', 'CANCELLED', 'REJECTED_SCAN'
  ))
) PARTITION BY RANGE (created_at);

-- Mesmo padrão de wms.ensure_stock_movement_partition (migration 0014):
-- SECURITY DEFINER porque wms_app só tem USAGE no schema, não CREATE.
CREATE OR REPLACE FUNCTION wms.ensure_putaway_task_partition(p_year INT, p_month INT)
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
  v_partition_name := format('putaway_task_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.putaway_task FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON wms.%I TO wms_app', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

-- Bootstrap: partição do mês corrente + do mês seguinte (manutenção
-- contínua é responsabilidade do PartitionManagerWorkerImpl, já registrado
-- para stock_movement/audit_log — este módulo adiciona putaway_task à
-- mesma lista, ver src/workers/partition-manager.worker.impl.ts).
DO $$
DECLARE
  v_now DATE := CURRENT_DATE;
  v_next DATE := (CURRENT_DATE + INTERVAL '1 month')::date;
BEGIN
  PERFORM wms.ensure_putaway_task_partition(EXTRACT(YEAR FROM v_now)::int, EXTRACT(MONTH FROM v_now)::int);
  PERFORM wms.ensure_putaway_task_partition(EXTRACT(YEAR FROM v_next)::int, EXTRACT(MONTH FROM v_next)::int);
END
$$;

CREATE INDEX IF NOT EXISTS idx_putaway_task_warehouse_status ON wms.putaway_task (warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_putaway_task_pallet ON wms.putaway_task (pallet_id);

ALTER TABLE wms.putaway_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.putaway_task FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS putaway_task_tenant_isolation ON wms.putaway_task;
CREATE POLICY putaway_task_tenant_isolation ON wms.putaway_task
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.putaway_task TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (39, 'DOC-04 RD-REC-005: putaway_task (TENANT, RLS, particionada RNF-ARQ-090) - ESTRUTURA apenas, geracao e Sessao 4B', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
