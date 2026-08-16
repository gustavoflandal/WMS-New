-- Migration: 0029
-- DOC-03 RD-POR-006 — yard_queue_entry (TENANT, RLS padrao ADR-RLS-003/004).
-- RN-POR-021: pontuacao e seus 4 componentes persistidos para auditoria.

CREATE TABLE IF NOT EXISTS wms.yard_queue_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  vehicle_visit_id UUID NOT NULL REFERENCES wms.vehicle_visit(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL,
  -- RN-POR-021: prioridade = P1*no_horario + P2*perecivel + P3*hazmat + P4*prioridade_manual.
  -- Componentes individuais persistidos (nao so o total) para auditoria/rastreabilidade.
  score NUMERIC NOT NULL,
  score_no_horario NUMERIC NOT NULL,
  score_perecivel NUMERIC NOT NULL,
  score_hazmat NUMERIC NOT NULL,
  score_prioridade_manual NUMERIC NOT NULL,
  manual_priority_reason TEXT,
  status TEXT NOT NULL DEFAULT 'WAITING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT yard_queue_entry_vehicle_visit_unique UNIQUE (vehicle_visit_id),
  CONSTRAINT yard_queue_entry_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  CONSTRAINT yard_queue_entry_status_check CHECK (status IN ('WAITING', 'CALLED', 'REMOVED'))
);

-- Ordenacao da fila: score DESC, desempate por chegada mais antiga (gate-in
-- mais antigo primeiro, RN-POR-021) — created_at ASC como proxy de
-- gate_in_at (a entrada na fila e criada no momento do gate-in bem-sucedido).
CREATE INDEX IF NOT EXISTS idx_yard_queue_entry_warehouse_order ON wms.yard_queue_entry (warehouse_id, direction, status, score DESC, created_at ASC);

ALTER TABLE wms.yard_queue_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.yard_queue_entry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS yard_queue_entry_tenant_isolation ON wms.yard_queue_entry;
CREATE POLICY yard_queue_entry_tenant_isolation ON wms.yard_queue_entry
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.yard_queue_entry TO wms_app;
-- RF-POR-020/RN-POR-021: YardQueueService.listQueue()/setManualPriority()
-- e DockCallService.confirmCall() leem a fila cross-tenant via
-- transactionAsWorker (ver nota de débito em yard-queue.service.ts).
GRANT SELECT, UPDATE ON wms.yard_queue_entry TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (29, 'DOC-03 RD-POR-006: yard_queue_entry (TENANT, RLS) - RN-POR-021 pontuacao', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
