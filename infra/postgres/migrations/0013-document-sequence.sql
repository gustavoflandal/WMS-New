-- Migration: 0013
-- DOC-02 §5.6 — Numeracao de documentos (resolve LAC-005), RN-DAD-040.
-- document_sequence (GLOBAL, RN-DAD-004: sem tenant_id, sem RLS).
-- UNIQUE(document_type, warehouse_id). O incremento atomico sob lock
-- (RNF-ARQ-021) e feito pelo DocumentNumberingService via
-- INSERT ... ON CONFLICT DO UPDATE (upsert atomico, serializado pelo indice
-- unico do Postgres -- nao precisa de SELECT ... FOR UPDATE explicito).
CREATE TABLE IF NOT EXISTS wms.document_sequence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  last_value BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT document_sequence_unique UNIQUE (document_type, warehouse_id),
  CONSTRAINT document_sequence_type_check CHECK (document_type IN (
    'INBOUND_ORDER', 'OUTBOUND_ORDER', 'TRANSFER', 'INVENTORY', 'LPN',
    'PRE_INVOICE', 'RETURN_ORDER', 'APPOINTMENT'
  )),
  CONSTRAINT document_sequence_last_value_check CHECK (last_value >= 0)
);

GRANT SELECT, INSERT, UPDATE ON wms.document_sequence TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (13, 'DOC-02 document numbering: document_sequence (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
