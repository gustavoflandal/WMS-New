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

-- RNF-ARQ-090: migration tracking table, read/written by MigrationRunner
-- (apps/backend/src/core/database/migration.runner.ts) and by every migration
-- file from 0005 onward that records itself via `INSERT ... ON CONFLICT DO NOTHING`.
CREATE TABLE IF NOT EXISTS wms.schema_migration (
  version INT PRIMARY KEY,
  description TEXT NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'SQL',
  installed_by VARCHAR(100) NOT NULL DEFAULT 'system',
  execution_time INT NOT NULL DEFAULT 0,
  installed_on TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Grant schema usage to wms_app
GRANT USAGE ON SCHEMA wms TO wms_app;

-- Grant default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app;
