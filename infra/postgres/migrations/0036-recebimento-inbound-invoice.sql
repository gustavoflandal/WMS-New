-- Migration: 0036
-- DOC-04 RD-REC-002 — inbound_invoice (TENANT, RLS). Chave 44, emitente,
-- valores, XML no S3; RN-REC-011/RG-014 passo 1: registra a NF-e e inicia
-- o prazo de regularização (client_warehouse_settings.inbound_invoice_
-- deadline_days) — o CONTROLE do prazo (alertas, expiração, efeitos) é do
-- DOC-08 [LACUNA: DOC-08 não existe nesta sessão]; aqui só a data-limite é
-- registrada.

CREATE TABLE IF NOT EXISTS wms.inbound_invoice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  inbound_order_id UUID NOT NULL REFERENCES wms.inbound_order(id) ON DELETE RESTRICT,
  access_key TEXT NOT NULL,
  issuer_cnpj TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  total_value NUMERIC(18,2) NOT NULL,
  -- Chave do objeto no MinIO (bucket configurado em MINIO_BUCKET_NAME) —
  -- guarda/validação do XML em si é do DOC-08; aqui o XML bruto é apenas
  -- persistido para rastreabilidade (RD-REC-002).
  xml_storage_key TEXT NOT NULL,
  -- RG-014 passo 1 / RN-REC-011: data-limite = data de registro + client_
  -- warehouse_settings.inbound_invoice_deadline_days.
  regularization_deadline DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT inbound_invoice_access_key_unique UNIQUE (access_key),
  CONSTRAINT inbound_invoice_access_key_format CHECK (access_key ~ '^[0-9]{44}$'),
  CONSTRAINT inbound_invoice_total_value_check CHECK (total_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inbound_invoice_order ON wms.inbound_invoice (inbound_order_id);
CREATE INDEX IF NOT EXISTS idx_inbound_invoice_tenant ON wms.inbound_invoice (tenant_id);

ALTER TABLE wms.inbound_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.inbound_invoice FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbound_invoice_tenant_isolation ON wms.inbound_invoice;
CREATE POLICY inbound_invoice_tenant_isolation ON wms.inbound_invoice
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.inbound_invoice TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (36, 'DOC-04 RD-REC-002: inbound_invoice (TENANT, RLS) - chave NFe, prazo RG-014 passo 1', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
