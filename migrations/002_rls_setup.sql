-- RNF-ARQ-010..013: Row-Level Security setup [INVIOLÁVEL]
-- Creates tenant context function and RLS policy template

-- Function to set tenant context in current transaction
-- RNF-ARQ-011: All queries MUST set this before accessing tenant data
CREATE OR REPLACE FUNCTION wms.set_tenant_context(
  p_tenant_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- RNF-ARQ-010: Per-connection tenant isolation
  EXECUTE 'SET LOCAL app.tenant_ids = ' || quote_literal(p_tenant_id::TEXT);
  EXECUTE 'SET LOCAL app.user_id = ' || quote_literal(p_user_id::TEXT);
END;
$$;

-- RLS policy template function (to be applied to each table in DOC-02)
-- RNF-ARQ-011: Policy function that checks tenant_id against context
CREATE OR REPLACE FUNCTION wms.rls_tenant_filter()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE LEAKPROOF
AS $$
DECLARE
  v_tenant_id TEXT;
BEGIN
  -- Get tenant context from current_setting (set by app)
  v_tenant_id := current_setting('app.tenant_ids', TRUE);

  -- If context not set, DENY all access
  IF v_tenant_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Check if row tenant_id matches context
  -- Table MUST have tenant_id column (RG-001)
  RETURN (SELECT tenant_id::TEXT = v_tenant_id FROM current_row);
END;
$$;

-- Enable RLS on wms schema (global setting)
ALTER SCHEMA wms ENABLE ROW LEVEL SECURITY;

-- Test table for RLS probe (RNF-ARQ-010)
-- [NOTE: Remove in migration 010 after tests pass]
CREATE TABLE wms.rls_probe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  data TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create RLS policy on test table
ALTER TABLE wms.rls_probe ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_tenant_isolation ON wms.rls_probe
  USING (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.tenant_ids', TRUE));

-- Grant to application role
GRANT SELECT, INSERT, UPDATE, DELETE ON wms.rls_probe TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (2, 'RLS setup: set_tenant_context function, policy template, rls_probe table', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
