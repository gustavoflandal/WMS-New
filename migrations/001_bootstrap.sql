-- RNF-ARQ-011, RG-010, RG-011: Migration 0001 - Bootstrap
-- Description: Initial schema setup with extensions, roles, and infrastructure tables
-- Date: 2026-08-11
-- Status: This bootstrap is applied via Docker initialization (01-schema.sql, 02-extensions.sql)

-- This file serves as documentation and version control reference for the bootstrap migration
-- Actual schema setup happens in infra/postgres/init/ SQL files

-- Executed SQL:
-- 1. CREATE EXTENSION pgcrypto - for UUID v7 and cryptographic functions
-- 2. CREATE FUNCTION uuid_v7() - sortable UUID generation (RG-011)
-- 3. CREATE SCHEMA wms - application schema
-- 4. CREATE ROLE wms_app - application user without BYPASSRLS (RNF-ARQ-011)
-- 5. CREATE TABLE wms.schema_migration - migration tracking table
-- 6. GRANT permissions - minimal required permissions to wms_app role

-- [LACUNA: Business tables will be added in subsequent migrations per DOC-02]
-- [LACUNA: RLS policies will be added in subsequent migrations per RG-001]
