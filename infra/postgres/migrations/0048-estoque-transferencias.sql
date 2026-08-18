-- Migration: 0048
-- DOC-05 §4.6 — Entregável 6: RD-EST-001 (wms.stock_transfer +
-- wms.stock_transfer_item), RF-EST-050 (transferência interna), RF-EST-051
-- (transferência entre armazéns, §5.2 CREATED->PICKING->IN_TRANSIT->
-- RECEIVING->COMPLETED, ramo CANCELLED antes do picking).

CREATE TABLE IF NOT EXISTS wms.stock_transfer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  transfer_type TEXT NOT NULL,
  warehouse_id_origin UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  -- INTERNAL: sempre igual a warehouse_id_origin (mesma armazém, endereço a
  -- endereço/palete a palete). INTERWAREHOUSE: armazém de destino real.
  warehouse_id_destination UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  -- RN-DAD-040: só INTERWAREHOUSE gera número formal ("documento TRF
  -- inter-armazém", RF-EST-051); INTERNAL "imediata em tela" (RF-EST-050) é
  -- ad-hoc, sem numeração — [LACUNA: DOC-05 diz "Documento TRF para
  -- transferências PLANEJADAS EM LOTE", não detalha se a transferência
  -- interna imediata também numera; inferência desta sessão: só numera
  -- quando há necessidade real de rastreamento formal entre armazéns].
  document_number TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT stock_transfer_type_check CHECK (transfer_type IN ('INTERNAL', 'INTERWAREHOUSE')),
  -- §5.2: CREATED -> PICKING -> IN_TRANSIT -> RECEIVING -> COMPLETED; CANCELLED é ramo (antes do picking).
  CONSTRAINT stock_transfer_status_check CHECK (status IN ('CREATED', 'PICKING', 'IN_TRANSIT', 'RECEIVING', 'COMPLETED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_tenant ON wms.stock_transfer (tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_warehouse_status ON wms.stock_transfer (warehouse_id_origin, status);

ALTER TABLE wms.stock_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_transfer FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_transfer_tenant_isolation ON wms.stock_transfer;
CREATE POLICY stock_transfer_tenant_isolation ON wms.stock_transfer
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.stock_transfer TO wms_app;

-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.stock_transfer_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  stock_transfer_id UUID NOT NULL REFERENCES wms.stock_transfer(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  location_id_origin UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id_origin UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  -- INTERNAL: conhecido na criação (Fase 1 já validada no destino,
  -- RF-EST-050). INTERWAREHOUSE: resolvido só no recebimento no destino
  -- (RF-EST-051) — [DÉBITO: "Ordem de Recebimento vinculada, conferência
  -- obrigatória" (DOC-04) não implementado nesta sessão; o crédito de saldo
  -- no destino é real (StockMovementService), mas sem o fluxo completo de
  -- conferência/divergência do DOC-04 — ver StockTransferService.completeReceiving].
  location_id_destination UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id_destination UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT stock_transfer_item_qty_check CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_item_transfer ON wms.stock_transfer_item (stock_transfer_id);

ALTER TABLE wms.stock_transfer_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_transfer_item FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_transfer_item_tenant_isolation ON wms.stock_transfer_item;
CREATE POLICY stock_transfer_item_tenant_isolation ON wms.stock_transfer_item
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.stock_transfer_item TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (48, 'DOC-05 RD-EST-001/RF-EST-050/051: wms.stock_transfer + stock_transfer_item (TENANT, RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
