-- Migration: 0004
-- Application Parameters Table for Dynamic Configuration
-- RD-ARQ-004: Parameterized configuration per scope (DOC-01)
-- Scenario: DOC-01 §6 — App Parameter scope resolution [INVIOLÁVEL]
-- Scopes (DOC-02 §5.7): GLOBAL, WAREHOUSE, CLIENT, CLIENT_WAREHOUSE
-- Precedence: CLIENT_WAREHOUSE > CLIENT > WAREHOUSE > GLOBAL

CREATE TABLE IF NOT EXISTS wms.app_parameter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  warehouse_id UUID,
  client_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for resolution queries
CREATE INDEX IF NOT EXISTS idx_app_parameter_scope
  ON wms.app_parameter(scope, name);

CREATE INDEX IF NOT EXISTS idx_app_parameter_warehouse
  ON wms.app_parameter(warehouse_id)
  WHERE warehouse_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_parameter_client
  ON wms.app_parameter(client_id)
  WHERE client_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON wms.app_parameter TO wms_app;

-- RLS Policy: Users can see parameters relevant to their scope (RNF-ARQ-011)
ALTER TABLE wms.app_parameter ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.app_parameter FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_parameter_scope_resolution ON wms.app_parameter;
DROP POLICY IF EXISTS app_parameter_write ON wms.app_parameter;
DROP POLICY IF EXISTS app_parameter_delete ON wms.app_parameter;
DROP POLICY IF EXISTS app_parameter_update ON wms.app_parameter;

-- Single policy covering SELECT/INSERT/UPDATE/DELETE (RNF-ARQ-011, RG-001).
-- NULLIF(...,'') normalizes server-level empty-string defaults to NULL before IS NOT NULL / ::UUID cast.
-- Deny-by-omission: no context configured or empty → no rows visible / no writes allowed.
-- GLOBAL rows are accessible to any configured tenant context (no warehouse/client needed).
-- WAREHOUSE/CLIENT/CLIENT_WAREHOUSE require the matching app.* setting to be non-empty.
CREATE POLICY app_parameter_visibility ON wms.app_parameter
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND (
      scope = 'GLOBAL'
      OR (scope = 'WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID)
      OR (scope = 'CLIENT'
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
      OR (scope = 'CLIENT_WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
    )
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND (
      scope = 'GLOBAL'
      OR (scope = 'WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID)
      OR (scope = 'CLIENT'
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
      OR (scope = 'CLIENT_WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
    )
  );
