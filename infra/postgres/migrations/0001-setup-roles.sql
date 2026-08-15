-- Migration: 0001
-- Setup PostgreSQL roles and schema permissions
-- RNF-ARQ-011: Create wms_app role (non-superuser) for RLS enforcement in tests
-- Idempotent: DO block catches duplicate-role without error output.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wms_app') THEN
    CREATE ROLE wms_app WITH LOGIN PASSWORD 'wms_app_password';
  END IF;
END
$$;

-- Allow wms_app to set custom app.* config parameters (RNF-ARQ-011: tenant context)
ALTER ROLE wms_app SET client_encoding TO 'UTF8';

-- Create schema wms
CREATE SCHEMA IF NOT EXISTS wms;

-- Grant schema usage to wms_app
GRANT USAGE ON SCHEMA wms TO wms_app;

-- Grant default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app;
