-- Migration: 0025
-- DOC-03 RD-POR-004 — visitor, person_visit (GLOBAL, RN-DAD-004). Ambos
-- classificados GLOBAL no proprio dicionario do DOC-03, apesar de
-- person_visit referenciar warehouse_id — mesmo padrao ja usado em
-- wms.zone/wms.location (GLOBAL com warehouse_id, sem RLS).

-- =============================================================================
-- visitor — RF-POR-030. "documento" sem formato especificado no DOC-03
-- (nao necessariamente CPF) — [LACUNA: DOC-03 nao define formato do
-- documento de identificacao do visitante] modelado como TEXT livre.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.visitor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT visitor_document_unique UNIQUE (document),
  CONSTRAINT visitor_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.visitor TO wms_app;

-- =============================================================================
-- person_visit — RF-POR-030/031. authorized_areas: lista de wms.zone.id
-- (RF-POR-030 "areas autorizadas (lista de zonas)"); mantido como UUID[]
-- sem FK por elemento (Postgres nao suporta FK em array) — a existencia de
-- cada zone_id e validada pela aplicacao (PersonVisitService) na criacao.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.person_visit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id UUID NOT NULL REFERENCES wms.visitor(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  host_reason TEXT NOT NULL,
  authorized_areas UUID[] NOT NULL DEFAULT '{}',
  valid_until TIMESTAMPTZ NOT NULL,
  photo_url TEXT,
  gate_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  gate_out_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ON_SITE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT person_visit_status_check CHECK (status IN ('ON_SITE', 'DEPARTED'))
);

CREATE INDEX IF NOT EXISTS idx_person_visit_warehouse_status ON wms.person_visit (warehouse_id, status);

GRANT SELECT, INSERT, UPDATE ON wms.person_visit TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (25, 'DOC-03 RD-POR-004: visitor, person_visit (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
