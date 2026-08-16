-- Migration: 0009
-- DOC-02 §5.1 — Organização (tabelas DE TENANT, RN-DAD-004: tenant_id = client.id,
-- RLS obrigatório). client, client_warehouse_settings, logical_warehouse,
-- logical_warehouse_location.
-- Padrão de policy: ADR-RLS-003/004 — NULLIF(current_setting('app.tenant_ids', true), ''),
-- deny-by-omission, sem USING(true) (mesmo padrão de 0004/0006/0007).

-- =============================================================================
-- client — DOC-02 §5.1
-- tenant_id DESTA tabela é o próprio `id` (glossário DOC-00 §4.2: "Cliente ...
-- Corresponde ao tenant_id"). Não há coluna tenant_id separada — a policy usa
-- `id` diretamente.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.client (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,               -- código curto único (máx. 10, A-Z0-9), imutável
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  cnpj TEXT NOT NULL,
  state_registration TEXT,
  address_street TEXT,
  address_number TEXT,
  address_complement TEXT,
  address_district TEXT,
  address_city TEXT,
  address_city_ibge_code TEXT,
  address_state TEXT,
  address_zip_code TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  contact_email TEXT,
  contact_phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT client_code_unique UNIQUE (code),
  CONSTRAINT client_cnpj_unique UNIQUE (cnpj),
  CONSTRAINT client_code_format CHECK (code ~ '^[A-Z0-9]{1,10}$'),
  CONSTRAINT client_cnpj_format CHECK (cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT client_cnpj_valid CHECK (wms.is_valid_cnpj(cnpj)),
  CONSTRAINT client_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'INACTIVE'))
);

CREATE TRIGGER client_code_immutable
  BEFORE UPDATE ON wms.client
  FOR EACH ROW EXECUTE FUNCTION wms.prevent_code_update();

ALTER TABLE wms.client ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.client FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_tenant_isolation ON wms.client;

-- Nota de implementação (não é [LACUNA], é resolução técnica do bootstrap):
-- para criar um client novo, a aplicação gera o UUID no lado do app (mesmo
-- padrão já usado em events.service.ts para event_id) e define
-- app.tenant_ids = esse UUID ANTES do INSERT, na mesma transação — assim
-- WITH CHECK passa porque id (a ser inserido) == contexto de tenant já ativo.
-- Administração cross-tenant (ex.: tela de "listar todos os clientes" para o
-- operador logístico) depende do modelo de permissões do DOC-12
-- [LACUNA: RBAC DOC-12] para autorizar a lista explícita de tenants (RG-001) —
-- não implementado nesta sessão.
CREATE POLICY client_tenant_isolation ON wms.client
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.client TO wms_app;

-- =============================================================================
-- client_warehouse_settings — DOC-02 §5.1 (configuração Cliente × Armazém)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.client_warehouse_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  fiscal_mode TEXT NOT NULL,                                   -- AD-002
  inbound_invoice_deadline_days INT,                           -- RG-014; padrão herdado de app_parameter
  logical_warehouse_enabled BOOLEAN NOT NULL DEFAULT FALSE,     -- ativa RG-015
  default_giro_policy TEXT NOT NULL,
  min_shelf_life_default_pct NUMERIC(5,2),
  blind_checking BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT client_warehouse_settings_unique UNIQUE (tenant_id, warehouse_id),
  CONSTRAINT client_warehouse_settings_fiscal_mode_check CHECK (fiscal_mode IN ('EMISSAO_PROPRIA', 'INTEGRADO_ERP', 'HIBRIDO')),
  CONSTRAINT client_warehouse_settings_giro_policy_check CHECK (default_giro_policy IN ('FEFO', 'FIFO', 'LIFO', 'JIT')),
  CONSTRAINT client_warehouse_settings_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED'))
);

ALTER TABLE wms.client_warehouse_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.client_warehouse_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_warehouse_settings_tenant_isolation ON wms.client_warehouse_settings;

CREATE POLICY client_warehouse_settings_tenant_isolation ON wms.client_warehouse_settings
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.client_warehouse_settings TO wms_app;

-- =============================================================================
-- logical_warehouse — DOC-02 §5.1 (RG-015)
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.logical_warehouse (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,   -- código exibido (máx. 10) — DOC-02 não define charset aqui
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT logical_warehouse_tenant_warehouse_unique UNIQUE (tenant_id, warehouse_id),
  CONSTRAINT logical_warehouse_code_length CHECK (char_length(code) <= 10),
  CONSTRAINT logical_warehouse_status_check CHECK (status IN ('ACTIVE', 'DEACTIVATING', 'INACTIVE'))
);

ALTER TABLE wms.logical_warehouse ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.logical_warehouse FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS logical_warehouse_tenant_isolation ON wms.logical_warehouse;

CREATE POLICY logical_warehouse_tenant_isolation ON wms.logical_warehouse
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.logical_warehouse TO wms_app;

-- =============================================================================
-- logical_warehouse_location — DOC-02 §5.1 (vínculo de endereços)
-- UNIQUE(location_id) é GLOBAL (RG-015: "um endereço pertence a no máximo 1
-- armazém lógico") — um índice único do Postgres é aplicado sobre TODAS as
-- linhas físicas da tabela independentemente de RLS (RLS só filtra
-- visibilidade em SELECT/UPDATE/DELETE; o índice único enxerga a tabela
-- inteira), então a exclusividade cross-tenant é garantida corretamente aqui.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.logical_warehouse_location (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  logical_warehouse_id UUID NOT NULL REFERENCES wms.logical_warehouse(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by UUID NOT NULL,   -- RG-015 item 4: vínculo com log
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT logical_warehouse_location_location_unique UNIQUE (location_id)
);

ALTER TABLE wms.logical_warehouse_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.logical_warehouse_location FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS logical_warehouse_location_tenant_isolation ON wms.logical_warehouse_location;

CREATE POLICY logical_warehouse_location_tenant_isolation ON wms.logical_warehouse_location
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

-- RN-DAD-003 permite DELETE físico em "vínculos N:N de configuração" — é
-- exatamente o que esta tabela é (vínculo location <-> logical_warehouse),
-- ao contrário das demais tabelas de 0008/0009 (entidades de negócio,
-- soft-delete via status). DELETE aqui é o que torna unlink() possível.
GRANT SELECT, INSERT, UPDATE, DELETE ON wms.logical_warehouse_location TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (9, 'DOC-02 organization: client, client_warehouse_settings, logical_warehouse, logical_warehouse_location (TENANT, RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
