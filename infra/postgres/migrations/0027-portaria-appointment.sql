-- Migration: 0027
-- DOC-03 RD-POR-001 — appointment (TENANT, RLS padrao ADR-RLS-003/004).
-- Numeracao pela mascara AGD (RN-DAD-040, DocumentNumberingService ja
-- suporta 'APPOINTMENT' desde a Sessao 2B).

CREATE TABLE IF NOT EXISTS wms.appointment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  window_config_id UUID NOT NULL REFERENCES wms.appointment_window_config(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL,
  window_date DATE NOT NULL,
  vehicle_type TEXT NOT NULL,
  -- ASN (inbound) / Pedido (outbound): RF-POR-001 exige vinculo OPCIONAL.
  -- [LACUNA: DOC-04 (wms.asn) e DOC-06 (wms.outbound_order) nao existem
  -- nesta sessao — nao ha tabela real para uma FK. Modelado como
  -- referencia textual livre ate esses documentos serem implementados.]
  asn_reference TEXT,
  order_reference TEXT,
  -- RN-POR-013 (hazmat) e RN-POR-021 (perecivel) dependem do conteudo do
  -- ASN/pedido vinculado. [LACUNA: sem ASN/pedido reais nesta sessao, a
  -- deteccao automatica por especie de produto (DOC-05) nao e possivel —
  -- declarado explicitamente no agendamento por quem o cria. Quando DOC-04
  -- existir, migrar para derivacao automatica dos itens do ASN.]
  contains_hazmat BOOLEAN NOT NULL DEFAULT FALSE,
  contains_perishable BOOLEAN NOT NULL DEFAULT FALSE,
  -- origin=SEM_AGENDA: RN-POR-012, agendamento retroativo criado a partir
  -- de gate-in sem agenda apos excecao aprovada (§5.2). Distinto de status
  -- porque um SEM_AGENDA nasce direto em CONFIRMED_ARRIVAL, nao SCHEDULED.
  origin TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT appointment_number_unique UNIQUE (number),
  CONSTRAINT appointment_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  CONSTRAINT appointment_origin_check CHECK (origin IN ('NORMAL', 'SEM_AGENDA')),
  -- §5.2: SCHEDULED -> CONFIRMED_ARRIVAL -> FULFILLED; ramos CANCELLED, NO_SHOW.
  CONSTRAINT appointment_status_check CHECK (status IN ('SCHEDULED', 'CONFIRMED_ARRIVAL', 'FULFILLED', 'CANCELLED', 'NO_SHOW'))
);

CREATE INDEX IF NOT EXISTS idx_appointment_warehouse_window ON wms.appointment (warehouse_id, window_config_id, window_date);
CREATE INDEX IF NOT EXISTS idx_appointment_tenant ON wms.appointment (tenant_id);

ALTER TABLE wms.appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.appointment FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointment_tenant_isolation ON wms.appointment;
CREATE POLICY appointment_tenant_isolation ON wms.appointment
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.appointment TO wms_app;
-- RN-POR-004: scheduler (wms_worker, ADR-006) marca NO_SHOW cross-tenant.
GRANT SELECT, UPDATE ON wms.appointment TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (27, 'DOC-03 RD-POR-001: appointment (TENANT, RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
