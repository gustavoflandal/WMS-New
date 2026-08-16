-- Migration: 0020
-- DOC-12 §4.5/§5.1 — operational_exception (RD-SEG-041, DE TENANT, RLS —
-- RD-SEG-063). Máquina de estados PENDING/ESCALATED/APPROVED/REJECTED/EXPIRED.
--
-- operational_exception_decision: tabela auxiliar NÃO listada literalmente
-- em RD-SEG-041 (que só cita `decided_by`/`decided_at` no singular) — mas
-- RN-SEG-043 exige "aprovadores distintos entre si" em fluxos de 2 passos,
-- o que exige registrar CADA decisão individualmente para poder comparar.
-- Decisão de modelagem desta sessão, documentada aqui (não é um valor
-- inventado do documento, é a estrutura mínima para tornar RN-SEG-043
-- verificável).

-- =============================================================================
-- operational_exception
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.operational_exception (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  exception_type TEXT NOT NULL REFERENCES wms.exception_type(code) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  qty NUMERIC(18,6),
  value_brl NUMERIC(14,4),
  reason_request TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  current_step INT NOT NULL DEFAULT 1,        -- decisão de modelagem: rastreia o passo corrente em fluxos de 2 passos
  requested_by UUID NOT NULL,
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  reason_decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT operational_exception_status_check CHECK (status IN ('PENDING', 'ESCALATED', 'APPROVED', 'REJECTED', 'EXPIRED')),
  CONSTRAINT operational_exception_decision_reason_check CHECK (
    status NOT IN ('APPROVED', 'REJECTED') OR reason_decision IS NOT NULL
  ),
  CONSTRAINT operational_exception_qty_check CHECK (qty IS NULL OR qty >= 0),
  CONSTRAINT operational_exception_value_check CHECK (value_brl IS NULL OR value_brl >= 0),
  CONSTRAINT operational_exception_step_check CHECK (current_step IN (1, 2))
);

CREATE INDEX IF NOT EXISTS idx_operational_exception_status ON wms.operational_exception (tenant_id, warehouse_id, status);

ALTER TABLE wms.operational_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.operational_exception FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operational_exception_tenant_isolation ON wms.operational_exception;
CREATE POLICY operational_exception_tenant_isolation ON wms.operational_exception
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.operational_exception TO wms_app;

-- ADR-006/wms_worker: least privilege -- só o que o worker precisa
-- (ExceptionExpiryWorkerImpl, RN-SEG-042, roda via transactionAsWorker,
-- BYPASSRLS, para expirar exceções cross-tenant). BYPASSRLS não implica
-- GRANT automático em nenhuma tabela -- precisa ser concedido explicitamente,
-- mesmo padrão de wms.event_outbox (migration 0005).
GRANT SELECT, UPDATE ON wms.operational_exception TO wms_worker;

-- =============================================================================
-- operational_exception_decision — 1 linha por passo decidido (RN-SEG-043)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.operational_exception_decision (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  operational_exception_id UUID NOT NULL REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  step INT NOT NULL,
  decision TEXT NOT NULL,
  decided_by UUID NOT NULL,
  reason TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operational_exception_decision_unique UNIQUE (operational_exception_id, step),
  CONSTRAINT operational_exception_decision_check CHECK (decision IN ('APPROVE', 'REJECT'))
);

ALTER TABLE wms.operational_exception_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.operational_exception_decision FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operational_exception_decision_tenant_isolation ON wms.operational_exception_decision;
CREATE POLICY operational_exception_decision_tenant_isolation ON wms.operational_exception_decision
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.operational_exception_decision TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (20, 'DOC-12 approval workflow instances: operational_exception, operational_exception_decision (TENANT, RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
