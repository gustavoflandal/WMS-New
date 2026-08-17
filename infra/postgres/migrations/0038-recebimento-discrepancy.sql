-- Migration: 0038
-- DOC-04 RD-REC-004 — discrepancy (TENANT, RLS). tipo, quantidades, fotos
-- (S3), vínculo à exceção do DOC-12 (wms.operational_exception, migration
-- 0020). RN-REC-022 [INVIOLÁVEL]: AVARIA exige >= 1 foto — CHECK direto na
-- tabela (não precisa de função separada: só compara colunas da própria
-- linha, diferente do caso de wms.all_nfe_keys_valid na migration 0028).

CREATE TABLE IF NOT EXISTS wms.discrepancy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  inbound_order_item_id UUID NOT NULL REFERENCES wms.inbound_order_item(id) ON DELETE RESTRICT,
  discrepancy_type TEXT NOT NULL,
  qty NUMERIC(18,6) NOT NULL,
  photo_keys TEXT[] NOT NULL DEFAULT '{}',
  -- TROCA (RN-REC-022): par item faltante + item excedente, vinculados.
  paired_discrepancy_id UUID REFERENCES wms.discrepancy(id) ON DELETE RESTRICT,
  operational_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  -- Efeito aplicado após decisão (RN-REC-023, tabela §4.3): preenchido só
  -- quando status = RESOLVED.
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  CONSTRAINT discrepancy_type_check CHECK (discrepancy_type IN ('FALTA', 'SOBRA', 'AVARIA', 'TROCA')),
  CONSTRAINT discrepancy_qty_check CHECK (qty > 0),
  CONSTRAINT discrepancy_status_check CHECK (status IN ('PENDING', 'RESOLVED')),
  CONSTRAINT discrepancy_resolution_check CHECK (
    resolution IS NULL OR resolution IN ('ADJUSTED', 'RECEIVED_BLOCKED', 'REFUSED_ITEM', 'RECEIVED_DAMAGED', 'RECOUNT')
  ),
  -- RN-REC-022 [INVIOLÁVEL]: AVARIA exige >= 1 foto, sem exceção.
  -- `cardinality()`, não `array_length(x,1)`: para array VAZIO (não NULL),
  -- array_length retorna NULL (não 0) — `NULL >= 1` é NULL, e um CHECK só
  -- reprova quando o resultado é FALSE (NULL passa), então a exigência de
  -- foto nunca era de fato aplicada para `photo_keys = '{}'` (bug real
  -- encontrado ao testar `CheckingService.registerAvaria()` sem foto pela
  -- 1ª vez — a exceção esperada não era lançada). `cardinality()` retorna
  -- 0 para array vazio, fechando o buraco.
  CONSTRAINT discrepancy_avaria_requires_photo CHECK (
    discrepancy_type != 'AVARIA' OR cardinality(photo_keys) >= 1
  )
);

CREATE INDEX IF NOT EXISTS idx_discrepancy_order_item ON wms.discrepancy (inbound_order_item_id);
CREATE INDEX IF NOT EXISTS idx_discrepancy_tenant ON wms.discrepancy (tenant_id);
CREATE INDEX IF NOT EXISTS idx_discrepancy_exception ON wms.discrepancy (operational_exception_id);

ALTER TABLE wms.discrepancy ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.discrepancy FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS discrepancy_tenant_isolation ON wms.discrepancy;
CREATE POLICY discrepancy_tenant_isolation ON wms.discrepancy
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.discrepancy TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (38, 'DOC-04 RD-REC-004: discrepancy (TENANT, RLS) - tipo/qty/fotos/vinculo a operational_exception, AVARIA exige foto', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
