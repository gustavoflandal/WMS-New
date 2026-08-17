-- Migration: 0040
-- DOC-04 RD-REC-006 — crossdock_link (TENANT, RLS). "ASN item x pedido x
-- quantidade x reserva" (RN-REC-050/RF-REC-051). outbound_order (DOC-06)
-- não existe nesta sessão — [LACUNA: DOC-06] sem FK real, vínculo por
-- referência textual do pedido (mesmo padrão já usado em
-- appointment.asn_reference/order_reference, migration 0027/Sessão 4).

CREATE TABLE IF NOT EXISTS wms.crossdock_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  inbound_order_item_id UUID NOT NULL REFERENCES wms.inbound_order_item(id) ON DELETE RESTRICT,
  -- [LACUNA: DOC-06 outbound_order não existe] — referência textual do
  -- pedido de saída vinculado (ex.: "PED-SP01-00000200", exemplo normativo
  -- do Gherkin §6).
  outbound_order_reference TEXT NOT NULL,
  qty_linked NUMERIC(18,6) NOT NULL,
  pallet_id UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT crossdock_link_qty_check CHECK (qty_linked > 0),
  -- RESERVED: vinculado antes da conferência (RN-REC-050). CONSUMED:
  -- palete de cross-dock formado e movido a zona CROSS_DOCKING
  -- (RF-REC-051). CANCELLED: pedido cancelado, reserva desfeita
  -- (RF-REC-051 "SE o Pedido vinculado for cancelado").
  CONSTRAINT crossdock_link_status_check CHECK (status IN ('RESERVED', 'CONSUMED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_crossdock_link_order_item ON wms.crossdock_link (inbound_order_item_id);
CREATE INDEX IF NOT EXISTS idx_crossdock_link_tenant ON wms.crossdock_link (tenant_id);
CREATE INDEX IF NOT EXISTS idx_crossdock_link_reference ON wms.crossdock_link (outbound_order_reference);

ALTER TABLE wms.crossdock_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.crossdock_link FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crossdock_link_tenant_isolation ON wms.crossdock_link;
CREATE POLICY crossdock_link_tenant_isolation ON wms.crossdock_link
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.crossdock_link TO wms_app;
-- RNF-REC-052: worker de alerta de permanência lê crossdock_link
-- cross-tenant (ADR-006, mesmo padrão de yard_queue_entry na Sessão 4).
GRANT SELECT ON wms.crossdock_link TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (40, 'DOC-04 RD-REC-006: crossdock_link (TENANT, RLS) - ASN item x pedido x quantidade x reserva', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
