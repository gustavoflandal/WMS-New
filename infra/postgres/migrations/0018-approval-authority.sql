-- Migration: 0018
-- DOC-12 §4.3/§4.5 — exception_type (RD-SEG-040, catalogo GLOBAL) e
-- approval_authority (RD-SEG-020, alcadas, GLOBAL — RD-SEG-061).

-- =============================================================================
-- exception_type — RD-SEG-040. "Cada documento-modulo declara suas
-- excecoes neste catalogo" -- DOC-04/DOC-05/DOC-06 nao existem nesta
-- sessao, entao o catalogo REAL desses modulos nao pode ser criado aqui
-- ("a IA geradora NAO PODE criar excecao fora dos catalogos declarados").
-- As DUAS excecoes abaixo sao inseridas apenas porque sao citadas
-- NOMINALMENTE pelo proprio DOC-12 em seus criterios de aceite (§6):
-- EST.QUEBRA_FEFO (cenario "solicitante nao aprova a propria excecao") e
-- REC.DIVERGENCIA_FALTA (cenario "escalonamento automatico"). Os demais
-- parametros (default_steps/requires_reason/auto_expire_hours) NAO sao
-- dados pelo documento para estes dois exemplos -- valores usados aqui sao
-- inferencia desta sessao, documentada linha a linha.
-- [LACUNA: catalogo real de excecoes de cada modulo operacional (REC.*,
-- EST.*, EXP.*) sera declarado quando DOC-03/04/05/06 forem implementados.]
CREATE TABLE IF NOT EXISTS wms.exception_type (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_steps INT NOT NULL,
  requires_reason BOOLEAN NOT NULL,
  auto_expire_hours INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT exception_type_code_format CHECK (code ~ '^[A-Z]+\.[A-Z_]+$'),
  CONSTRAINT exception_type_steps_check CHECK (default_steps IN (1, 2)),
  CONSTRAINT exception_type_expire_check CHECK (auto_expire_hours > 0)
);

GRANT SELECT, INSERT, UPDATE ON wms.exception_type TO wms_app;

-- ADR-006/wms_worker: ExceptionExpiryWorkerImpl (RN-SEG-042, scheduler) lê
-- auto_expire_hours daqui via transactionAsWorker (BYPASSRLS) -- BYPASSRLS
-- não concede GRANT automático, precisa ser explícito (mesmo padrão de
-- wms.event_outbox na migration 0005).
GRANT SELECT ON wms.exception_type TO wms_worker;

INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  -- 2 passos: usado tambem para testar RN-SEG-043 (aprovadores distintos entre si e do solicitante).
  ('EST.QUEBRA_FEFO',        'Quebra de politica FEFO (RG-006)',        2, TRUE, 24, '00000000-0000-0000-0000-000000000001'),
  ('REC.DIVERGENCIA_FALTA',  'Divergencia de falta no recebimento',     1, TRUE, 24, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- approval_authority — RD-SEG-020
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.approval_authority (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES wms.role(id) ON DELETE RESTRICT,
  exception_type TEXT NOT NULL REFERENCES wms.exception_type(code) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  max_qty NUMERIC(18,6),
  max_value_brl NUMERIC(14,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT approval_authority_unique UNIQUE (role_id, exception_type, warehouse_id),
  CONSTRAINT approval_authority_max_qty_check CHECK (max_qty IS NULL OR max_qty >= 0),
  CONSTRAINT approval_authority_max_value_check CHECK (max_value_brl IS NULL OR max_value_brl >= 0)
);

GRANT SELECT, INSERT, UPDATE ON wms.approval_authority TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (18, 'DOC-12 approval workflow catalog: exception_type, approval_authority (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
