-- Migration: 0035
-- DOC-04 RD-REC-001 — inbound_order + inbound_order_item (TENANT, RLS).
-- Estado §5.1. item guarda esperado/contado/recebido + vínculo NF-e/ASN.

CREATE TABLE IF NOT EXISTS wms.inbound_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  -- Vínculo com a visita de veículo do DOC-03 — "chegada e fila do veículo
  -- são do DOC-03" (§1 Fronteiras). Nullable: RF-REC-010(a/b) permite ASN
  -- criado ANTES da chegada física (XML de NF-e/ERP como pré-aviso);
  -- setado/validado na atracação (RF-REC-002).
  vehicle_visit_id UUID REFERENCES wms.vehicle_visit(id) ON DELETE RESTRICT,
  dock_id UUID REFERENCES wms.dock(id) ON DELETE RESTRICT,
  -- RF-REC-010: três origens possíveis. Integração ERP fica [LACUNA: DOC-13]
  -- nesta sessão — o valor ERP existe no enum (citado no próprio RF-REC-010)
  -- mas nenhum endpoint desta sessão o produz.
  origin TEXT NOT NULL,
  -- Snapshot de client_warehouse_settings.blind_checking no momento da
  -- criação (RF-REC-021) — mudanças posteriores no parâmetro não alteram
  -- retroativamente uma ordem já em andamento.
  blind_checking BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  refusal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT inbound_order_number_unique UNIQUE (number),
  CONSTRAINT inbound_order_origin_check CHECK (origin IN ('XML_NFE', 'ERP', 'MANUAL')),
  -- §5.1: máquina de estados completa da Ordem de Recebimento.
  CONSTRAINT inbound_order_status_check CHECK (status IN (
    'CREATED', 'AT_DOCK', 'UNLOADING', 'CHECKING', 'DISCREPANCY_PENDING',
    'CHECKED', 'LABELING', 'PUTAWAY_IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REFUSED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_inbound_order_warehouse_status ON wms.inbound_order (warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_inbound_order_tenant ON wms.inbound_order (tenant_id);
CREATE INDEX IF NOT EXISTS idx_inbound_order_vehicle_visit ON wms.inbound_order (vehicle_visit_id);

ALTER TABLE wms.inbound_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.inbound_order FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbound_order_tenant_isolation ON wms.inbound_order;
CREATE POLICY inbound_order_tenant_isolation ON wms.inbound_order
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.inbound_order TO wms_app;

-- =============================================================================
-- inbound_order_item — RN-REC-012: item pode não casar com produto
-- cadastrado (SEM_CADASTRO); por isso product_id é NULLABLE e os campos
-- raw_* guardam o que veio da NF-e/ASN até o vínculo ser feito.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.inbound_order_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  inbound_order_id UUID NOT NULL REFERENCES wms.inbound_order(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES wms.product(id) ON DELETE RESTRICT,
  raw_sku TEXT,
  raw_description TEXT,
  raw_ean TEXT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  qty_expected NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_counted NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_received NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT inbound_order_item_qty_expected_check CHECK (qty_expected >= 0),
  CONSTRAINT inbound_order_item_qty_counted_check CHECK (qty_counted >= 0),
  CONSTRAINT inbound_order_item_qty_received_check CHECK (qty_received >= 0),
  -- SEM_CADASTRO (RN-REC-012); CHECKING_PENDING = aguardando 1a contagem;
  -- RECOUNT_PENDING = 1a contagem divergiu, aguardando recontagem
  -- (RN-REC-022); CHECKED = quantidade final apurada, sem exceção pendente.
  CONSTRAINT inbound_order_item_status_check CHECK (status IN (
    'PENDING', 'SEM_CADASTRO', 'CHECKING_PENDING', 'RECOUNT_PENDING', 'CHECKED', 'REFUSED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_inbound_order_item_order ON wms.inbound_order_item (inbound_order_id);
CREATE INDEX IF NOT EXISTS idx_inbound_order_item_tenant ON wms.inbound_order_item (tenant_id);

ALTER TABLE wms.inbound_order_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.inbound_order_item FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbound_order_item_tenant_isolation ON wms.inbound_order_item;
CREATE POLICY inbound_order_item_tenant_isolation ON wms.inbound_order_item
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.inbound_order_item TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (35, 'DOC-04 RD-REC-001: inbound_order + inbound_order_item (TENANT, RLS) - maquina de estados Sec 5.1', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
