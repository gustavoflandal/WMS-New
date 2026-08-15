-- Migration: 0002
-- RLS Probe Table for Testing Row-Level Security
-- RNF-ARQ-011: Test table for RLS validation
-- Scenario: DOC-01 §6 — RLS enforcement between tenants [INVIOLÁVEL]

CREATE TABLE IF NOT EXISTS wms.rls_probe (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  data TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

GRANT SELECT, INSERT, UPDATE, DELETE ON wms.rls_probe TO wms_app;

-- RLS Policy: Tenants can only see their own data (RG-001, RNF-ARQ-011)
ALTER TABLE wms.rls_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.rls_probe FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_probe_tenant_isolation ON wms.rls_probe;

-- NULLIF(...,'') normalizes server-level empty-string defaults to NULL before IS NOT NULL / ::UUID cast.
-- deny-by-omission: no context configured or empty context → no rows (RG-001, RNF-ARQ-011).
CREATE POLICY rls_probe_tenant_isolation ON wms.rls_probe
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );
