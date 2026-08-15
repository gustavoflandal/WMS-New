-- RNF-ARQ-080: Application parameters with scope resolution
-- Hierarchy: CLIENT_WAREHOUSE > CLIENT > WAREHOUSE > GLOBAL
-- Each parameter resolved from most specific to least specific scope

CREATE TYPE wms.parameter_scope AS ENUM (
  'GLOBAL',           -- Applies to all clients, all warehouses
  'WAREHOUSE',        -- Specific warehouse, all clients
  'CLIENT',           -- Specific client, all warehouses
  'CLIENT_WAREHOUSE'  -- Specific client + warehouse (most specific)
);

CREATE TABLE wms.app_parameter (
  parameter_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,  -- Stored as JSON string for flexibility
  scope wms.parameter_scope NOT NULL DEFAULT 'GLOBAL',
  tenant_id UUID,  -- NULL for GLOBAL and WAREHOUSE scopes
  warehouse_id UUID,  -- NULL for GLOBAL and CLIENT scopes
  description TEXT,
  data_type VARCHAR(50) DEFAULT 'STRING',  -- STRING, INT, BOOLEAN, JSON
  is_secret BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID,
  UNIQUE (key, scope, tenant_id, warehouse_id)
);

-- RLS policy: allow reading all GLOBAL params, but own scoped params
ALTER TABLE wms.app_parameter ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_parameter_read ON wms.app_parameter FOR SELECT
  USING (
    scope = 'GLOBAL'
    OR tenant_id::TEXT = current_setting('app.tenant_ids', TRUE)
  );

CREATE POLICY rls_parameter_write ON wms.app_parameter FOR INSERT, UPDATE, DELETE
  USING (
    scope = 'GLOBAL'  -- Only GLOBAL can be modified by admin role
    OR tenant_id::TEXT = current_setting('app.tenant_ids', TRUE)
  );

-- Indexes for scope resolution lookup
CREATE INDEX idx_app_parameter_key_scope ON wms.app_parameter (key, scope);

CREATE INDEX idx_app_parameter_tenant_warehouse ON wms.app_parameter (tenant_id, warehouse_id, key)
  WHERE scope IN ('CLIENT_WAREHOUSE', 'CLIENT', 'WAREHOUSE');

-- Function: resolve parameter value by scope hierarchy
-- Searches in order: CLIENT_WAREHOUSE > CLIENT > WAREHOUSE > GLOBAL
-- [LACUNA: Caching of this function result (RNF-ARQ-020) to be added in session 1.5]
CREATE OR REPLACE FUNCTION wms.get_parameter(
  p_key VARCHAR,
  p_tenant_id UUID DEFAULT NULL,
  p_warehouse_id UUID DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_value TEXT;
BEGIN
  -- Scope 1: CLIENT_WAREHOUSE (most specific)
  IF p_tenant_id IS NOT NULL AND p_warehouse_id IS NOT NULL THEN
    SELECT value INTO v_value
    FROM wms.app_parameter
    WHERE key = p_key
      AND scope = 'CLIENT_WAREHOUSE'
      AND tenant_id = p_tenant_id
      AND warehouse_id = p_warehouse_id;

    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END IF;

  -- Scope 2: CLIENT
  IF p_tenant_id IS NOT NULL THEN
    SELECT value INTO v_value
    FROM wms.app_parameter
    WHERE key = p_key
      AND scope = 'CLIENT'
      AND tenant_id = p_tenant_id
      AND warehouse_id IS NULL;

    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END IF;

  -- Scope 3: WAREHOUSE
  IF p_warehouse_id IS NOT NULL THEN
    SELECT value INTO v_value
    FROM wms.app_parameter
    WHERE key = p_key
      AND scope = 'WAREHOUSE'
      AND tenant_id IS NULL
      AND warehouse_id = p_warehouse_id;

    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END IF;

  -- Scope 4: GLOBAL (least specific, fallback)
  SELECT value INTO v_value
  FROM wms.app_parameter
  WHERE key = p_key
    AND scope = 'GLOBAL'
    AND tenant_id IS NULL
    AND warehouse_id IS NULL;

  RETURN v_value;
END;
$$;

-- Grants
GRANT SELECT ON wms.app_parameter TO wms_app;
GRANT INSERT, UPDATE ON wms.app_parameter TO wms_app;  -- For client-scoped params

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (5, 'App parameter: scope-resolved config, hierarchy function, RLS', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
