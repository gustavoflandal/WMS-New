-- Migration: 0008
-- DOC-02 §5.2 — Estrutura física (tabelas GLOBAIS, RN-DAD-004: sem tenant_id, sem RLS)
-- warehouse, zone, storage_equipment, location, dock, yard_slot.
-- RN-DAD-002: colunas obrigatórias (id, created_at, created_by, updated_at, updated_by)
-- em todas as tabelas. RN-DAD-005: enums como TEXT + CHECK. RN-DAD-006: FKs ON DELETE
-- RESTRICT, nunca CASCADE.

-- Nota de precedente: gen_random_uuid() (UUIDv4) é usado como default de PK, seguindo
-- o mesmo padrão já estabelecido nas migrations 0002-0007 (não UUIDv7 como RG-011
-- pede em tese — [DEBITO: migrar toda a base para UUIDv7 real, sessão a definir;
-- mantido por consistência com o schema já existente, "não refatore código que já
-- passa nos testes").

-- ---------------------------------------------------------------------------
-- Função compartilhada: validação de dígito verificador de CNPJ (client.cnpj,
-- DOC-02 §5.1; warehouse.cnpj, DOC-02 §5.2). Algoritmo padrão Receita Federal
-- (módulo 11, pesos 5-4-3-2-9-8-7-6-5-4-3-2 / 6-5-4-3-2-9-8-7-6-5-4-3-2).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms.is_valid_cnpj(p_cnpj TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  digits INT[];
  i INT;
  sum1 INT := 0;
  sum2 INT := 0;
  weights1 INT[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2];
  weights2 INT[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
  dv1 INT;
  dv2 INT;
BEGIN
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN
    RETURN FALSE;
  END IF;

  -- Sequencias de dígito único (00000000000000 etc.) passam matematicamente
  -- no módulo 11 mas não são CNPJs válidos.
  IF p_cnpj ~ '^(\d)\1{13}$' THEN
    RETURN FALSE;
  END IF;

  FOR i IN 1..14 LOOP
    digits[i] := substring(p_cnpj FROM i FOR 1)::INT;
  END LOOP;

  FOR i IN 1..12 LOOP
    sum1 := sum1 + digits[i] * weights1[i];
  END LOOP;
  dv1 := 11 - (sum1 % 11);
  IF dv1 >= 10 THEN dv1 := 0; END IF;

  FOR i IN 1..13 LOOP
    sum2 := sum2 + digits[i] * weights2[i];
  END LOOP;
  dv2 := 11 - (sum2 % 11);
  IF dv2 >= 10 THEN dv2 := 0; END IF;

  RETURN digits[13] = dv1 AND digits[14] = dv2;
END;
$$;

-- ---------------------------------------------------------------------------
-- Função compartilhada: bloqueia UPDATE da coluna `code` (RF-DAD-050 —
-- imutabilidade de códigos após criação). Reutilizada por warehouse (aqui) e
-- client (migration 0009).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms.prevent_code_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'RF-DAD-050: code is immutable after creation (% -> %)', OLD.code, NEW.code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- warehouse — DOC-02 §5.2
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.warehouse (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,                 -- código curto único (máx. 6, A-Z0-9), usado nas máscaras de numeração (DOC-02 §6)
  name TEXT NOT NULL,
  cnpj TEXT NOT NULL,                 -- CNPJ da filial do operador logístico (emitente fiscal, DOC-08)
  address_street TEXT,
  address_number TEXT,
  address_complement TEXT,
  address_district TEXT,
  address_city TEXT,
  address_city_ibge_code TEXT,
  address_state TEXT,
  address_zip_code TEXT,
  timezone TEXT NOT NULL,             -- IANA, ex. America/Sao_Paulo
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,           -- [DEBITO: FK para wms.user quando DOC-12 criar a tabela]
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT warehouse_code_unique UNIQUE (code),
  CONSTRAINT warehouse_code_format CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  CONSTRAINT warehouse_cnpj_format CHECK (cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT warehouse_cnpj_valid CHECK (wms.is_valid_cnpj(cnpj)),
  CONSTRAINT warehouse_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE TRIGGER warehouse_code_immutable
  BEFORE UPDATE ON wms.warehouse
  FOR EACH ROW EXECUTE FUNCTION wms.prevent_code_update();

GRANT SELECT, INSERT, UPDATE ON wms.warehouse TO wms_app;

-- =============================================================================
-- zone — DOC-02 §5.2
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.zone (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  zone_type TEXT NOT NULL,
  -- allowed_species referencia valores de product_species.code (DOC-02 §5.3),
  -- fora do escopo desta sessão (2A é só §5.1/§5.2) — sem FK de array possível
  -- em Postgres; validação de pertencimento fica para quando product_species
  -- existir (Sessão 2B). [DEBITO: validar allowed_species contra product_species.code, sessão 2B]
  allowed_species TEXT[] NOT NULL DEFAULT '{}',
  temperature_min_c NUMERIC(5,2),
  temperature_max_c NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT zone_warehouse_code_unique UNIQUE (warehouse_id, code),
  CONSTRAINT zone_type_check CHECK (zone_type IN (
    'RECEIVING', 'QUARANTINE', 'STORAGE', 'PICKING', 'PACKING', 'WEIGHING',
    'DISPATCH', 'CROSS_DOCKING', 'RETURNS', 'DAMAGED', 'CLASSIFIED_FLAMMABLE',
    'CONTROLLED', 'COLD', 'FROZEN'
  )),
  CONSTRAINT zone_status_check CHECK (status IN ('ACTIVE', 'BLOCKED', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.zone TO wms_app;

-- =============================================================================
-- storage_equipment — DOC-02 §5.2
-- access_policy é DERIVADA do equipment_type ("política física de acesso
-- derivada do tipo") — implementada como coluna gerada para tornar a
-- correspondência impossível de divergir (RN-DAD-010 depende dela).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.storage_equipment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  equipment_type TEXT NOT NULL,
  access_policy TEXT GENERATED ALWAYS AS (
    CASE equipment_type
      WHEN 'PORTA_PALETES' THEN 'RANDOM'
      WHEN 'ESTANTE'       THEN 'RANDOM'
      WHEN 'GAVETEIRO'     THEN 'RANDOM'
      WHEN 'CANTILEVER'    THEN 'RANDOM'
      WHEN 'DRIVE_IN'      THEN 'LIFO_PHYSICAL'
      WHEN 'BLOCADO'       THEN 'LIFO_PHYSICAL'
      WHEN 'DRIVE_THRU'    THEN 'FIFO_PHYSICAL'
      WHEN 'FLOWRACK'      THEN 'FIFO_PHYSICAL'
      WHEN 'CARROSSEL'     THEN 'AUTOMATED'
    END
  ) STORED,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT storage_equipment_warehouse_code_unique UNIQUE (warehouse_id, code),
  CONSTRAINT storage_equipment_type_check CHECK (equipment_type IN (
    'PORTA_PALETES', 'DRIVE_IN', 'DRIVE_THRU', 'CANTILEVER', 'FLOWRACK',
    'ESTANTE', 'GAVETEIRO', 'CARROSSEL', 'BLOCADO'
  )),
  CONSTRAINT storage_equipment_access_policy_not_null CHECK (access_policy IS NOT NULL),
  CONSTRAINT storage_equipment_status_check CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.storage_equipment TO wms_app;

-- =============================================================================
-- location — DOC-02 §5.2
-- code é GERADA por RN-DAD-011 [INVIOLÁVEL]: aisle || '-' || module || '-' || level || '-' || slot
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.location (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  zone_id UUID NOT NULL REFERENCES wms.zone(id) ON DELETE RESTRICT,
  storage_equipment_id UUID REFERENCES wms.storage_equipment(id) ON DELETE RESTRICT, -- NULL para piso/blocado demarcado
  aisle TEXT NOT NULL,   -- Rua (2 chars, ex. A1)
  module TEXT NOT NULL,  -- Módulo (3 dígitos)
  level TEXT NOT NULL,   -- Nível (2 chars; 00 = piso)
  slot TEXT NOT NULL,    -- Vão (2 dígitos)
  code TEXT GENERATED ALWAYS AS (aisle || '-' || module || '-' || level || '-' || slot) STORED, -- RN-DAD-011 [INVIOLÁVEL]
  location_type TEXT NOT NULL,
  max_weight_kg NUMERIC(12,3) NOT NULL,
  max_volume_m3 NUMERIC(12,4) NOT NULL,
  max_pallets INT NOT NULL,
  max_height_m NUMERIC(8,3) NOT NULL,
  abc_class TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT location_warehouse_code_unique UNIQUE (warehouse_id, code),
  CONSTRAINT location_coordinates_unique UNIQUE (warehouse_id, aisle, module, level, slot),
  CONSTRAINT location_aisle_format CHECK (char_length(aisle) = 2),
  CONSTRAINT location_module_format CHECK (module ~ '^[0-9]{3}$'),
  CONSTRAINT location_level_format CHECK (char_length(level) = 2),
  CONSTRAINT location_slot_format CHECK (slot ~ '^[0-9]{2}$'),
  CONSTRAINT location_type_check CHECK (location_type IN (
    'STORAGE', 'PICKING', 'STAGING_IN', 'STAGING_OUT', 'QUARANTINE', 'DAMAGED', 'CROSS_DOCK'
  )),
  CONSTRAINT location_abc_class_check CHECK (abc_class IS NULL OR abc_class IN ('A', 'B', 'C')),
  CONSTRAINT location_status_check CHECK (status IN ('ACTIVE', 'BLOCKED', 'INVENTORY', 'INACTIVE'))
);

-- RF-DAD-050: location.code é imutável — como é coluna GERADA, o próprio
-- Postgres já rejeita UPDATE direto em `code`; este trigger cobre o caminho
-- indireto (alterar aisle/module/level/slot recomputaria code).
CREATE OR REPLACE FUNCTION wms.prevent_location_coordinates_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.aisle IS DISTINCT FROM OLD.aisle
     OR NEW.module IS DISTINCT FROM OLD.module
     OR NEW.level IS DISTINCT FROM OLD.level
     OR NEW.slot IS DISTINCT FROM OLD.slot THEN
    RAISE EXCEPTION 'RF-DAD-050: location code (aisle-module-level-slot) is immutable after creation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER location_coordinates_immutable
  BEFORE UPDATE ON wms.location
  FOR EACH ROW EXECUTE FUNCTION wms.prevent_location_coordinates_update();

GRANT SELECT, INSERT, UPDATE ON wms.location TO wms_app;

-- =============================================================================
-- dock — DOC-02 §5.2
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.dock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  dock_type TEXT NOT NULL,
  allowed_vehicle_types TEXT[],
  has_leveler BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'FREE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT dock_warehouse_code_unique UNIQUE (warehouse_id, code),
  CONSTRAINT dock_type_check CHECK (dock_type IN ('INBOUND', 'OUTBOUND', 'BOTH')),
  CONSTRAINT dock_status_check CHECK (status IN ('FREE', 'RESERVED', 'OCCUPIED', 'BLOCKED', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.dock TO wms_app;

-- =============================================================================
-- yard_slot — DOC-02 §5.2
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.yard_slot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  slot_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'FREE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT yard_slot_warehouse_code_unique UNIQUE (warehouse_id, code),
  CONSTRAINT yard_slot_type_check CHECK (slot_type IN ('WAITING', 'PARKING', 'HAZMAT')),
  CONSTRAINT yard_slot_status_check CHECK (status IN ('FREE', 'OCCUPIED', 'BLOCKED', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.yard_slot TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (8, 'DOC-02 warehouse structure: warehouse, zone, storage_equipment, location, dock, yard_slot (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
