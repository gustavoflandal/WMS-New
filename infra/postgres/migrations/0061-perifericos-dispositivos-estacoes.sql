-- Migration: 0061
-- DOC-11 RD-PER-001/002 — peripheral_device, workstation, workstation_device.
-- Classificação GLOBAL (DOC-11 §7): mesmo padrão de wms.warehouse/zone/
-- location (migration 0008) — sem tenant_id, sem RLS, GRANT direto a
-- wms_app. Periféricos são infraestrutura do ARMAZÉM (operador), não dado
-- de cliente; PER.GESTAO_DISPOSITIVOS/RF-PER-004 nunca filtram por cliente.
--
-- wms.edge_agent (migration 0007, Sessão 1) É de tenant (RLS) — decisão
-- daquela sessão, fora de escopo mudar aqui ("estenda, não duplique"); o
-- FK de peripheral_device para edge_agent funciona normalmente
-- (peripheral_device não tem RLS própria, mas isso não impede referenciar
-- uma PK de tabela que tem).

CREATE TYPE wms.peripheral_device_status AS ENUM (
  'ONLINE',
  'OFFLINE',
  'ERRO',
  'MANUTENCAO'
);

-- =============================================================================
-- peripheral_device — RD-PER-001. driver_code é o catálogo fechado de
-- drivers (§4.4–§4.7); function é o catálogo fechado de funções (RF-PER-004
-- lista as 5 mapeáveis por Estação; LPR é peritérico mas NÃO é mapeado por
-- Estação — câmera fixa por pista/local, não por posto de trabalho de
-- usuário — daí a 6ª opção fora do CHECK de workstation_device).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.peripheral_device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  edge_agent_id UUID NOT NULL REFERENCES wms.edge_agent(edge_agent_id) ON DELETE RESTRICT,
  device_code TEXT NOT NULL,
  function TEXT NOT NULL,
  driver_code TEXT NOT NULL,
  connection_params JSONB NOT NULL DEFAULT '{}',
  status wms.peripheral_device_status NOT NULL DEFAULT 'OFFLINE',
  status_detail TEXT,
  last_telemetry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT peripheral_device_code_unique UNIQUE (device_code),
  CONSTRAINT peripheral_device_function_check CHECK (function IN (
    'IMPRESSORA_ETIQUETA', 'IMPRESSORA_DOCUMENTO', 'BALANCA', 'CANCELA', 'CATRACA', 'LPR'
  )),
  CONSTRAINT peripheral_device_driver_check CHECK (driver_code IN (
    'ZPL_TCP',            -- RNF-PER-030
    'PDF_SPOOLER',        -- RNF-PER-031
    'TOLEDO_P05',         -- RNF-PER-040
    'FILIZOLA_CS',        -- RNF-PER-040
    'GENERICO_CONTINUO',  -- RNF-PER-040
    'RELE_IP',            -- RNF-PER-050
    'MODBUS_TCP',         -- RNF-PER-050
    'LPR_PUSH',           -- RNF-PER-060
    'LPR_POLLING'         -- RNF-PER-060
  )),
  -- Correspondência função <-> família de driver (evita cadastrar, por
  -- exemplo, uma BALANCA com driver ZPL_TCP).
  CONSTRAINT peripheral_device_function_driver_match CHECK (
    (function = 'IMPRESSORA_ETIQUETA' AND driver_code = 'ZPL_TCP') OR
    (function = 'IMPRESSORA_DOCUMENTO' AND driver_code = 'PDF_SPOOLER') OR
    (function = 'BALANCA' AND driver_code IN ('TOLEDO_P05', 'FILIZOLA_CS', 'GENERICO_CONTINUO')) OR
    (function = 'CANCELA' AND driver_code IN ('RELE_IP', 'MODBUS_TCP')) OR
    (function = 'CATRACA' AND driver_code IN ('RELE_IP', 'MODBUS_TCP')) OR
    (function = 'LPR' AND driver_code IN ('LPR_PUSH', 'LPR_POLLING'))
  )
);

CREATE INDEX IF NOT EXISTS idx_peripheral_device_agent ON wms.peripheral_device(edge_agent_id);
CREATE INDEX IF NOT EXISTS idx_peripheral_device_warehouse ON wms.peripheral_device(warehouse_id, function);

GRANT SELECT, INSERT, UPDATE ON wms.peripheral_device TO wms_app;

-- =============================================================================
-- workstation — RD-PER-002.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.workstation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT workstation_warehouse_code_unique UNIQUE (warehouse_id, code),
  CONSTRAINT workstation_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.workstation TO wms_app;

-- =============================================================================
-- workstation_device — RD-PER-002 (mapa Estação x função x dispositivo).
-- UNIQUE(workstation_id, function): 1 dispositivo por função por Estação
-- (RF-PER-004 — "a tela resolve o dispositivo pela Estação da sessão").
-- function aqui exclui LPR de propósito (ver nota em peripheral_device):
-- LPR não é resolvido por Estação de usuário.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.workstation_device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workstation_id UUID NOT NULL REFERENCES wms.workstation(id) ON DELETE RESTRICT,
  function TEXT NOT NULL,
  peripheral_device_id UUID NOT NULL REFERENCES wms.peripheral_device(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT workstation_device_unique UNIQUE (workstation_id, function),
  CONSTRAINT workstation_device_function_check CHECK (function IN (
    'IMPRESSORA_ETIQUETA', 'IMPRESSORA_DOCUMENTO', 'BALANCA', 'CANCELA', 'CATRACA'
  ))
);

CREATE INDEX IF NOT EXISTS idx_workstation_device_device ON wms.workstation_device(peripheral_device_id);

GRANT SELECT, INSERT, UPDATE ON wms.workstation_device TO wms_app;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (61, 'DOC-11: peripheral_device, workstation, workstation_device (GLOBAL)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
