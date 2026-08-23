-- Migration: 0066
-- DOC-15 (Sessão COL-1) — plataforma PWA de coletor.
-- Catálogo de permissões COL.* (§3), wms.field_device (RD-COL-001,
-- RNF-COL-003), PIN de coletor em wms.user (RF-SEG-004/RF-COL-030),
-- parâmetros COL.* (§7).

-- =============================================================================
-- Catálogo de permissões COL.*
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('COL.OPERAR',           'WAREHOUSE',        'Acesso a area field do PWA de coletor (DOC-15 RNF-COL-001)',        FALSE, '00000000-0000-0000-0000-000000000001'),
  ('COL.DISPOSITIVO_GERIR','WAREHOUSE',        'Registro e bloqueio de field_device (DOC-15 RNF-COL-003)',          TRUE,  '00000000-0000-0000-0000-000000000001'),
  ('COL.CONSULTA_SALDO',   'CLIENT_WAREHOUSE', 'Tela de consulta de saldo no coletor, T7 (DOC-15 SS4.5)',            FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- Papeis de campo (DOC-15 SS3: "Operadores de campo") recebem COL.OPERAR/
-- COL.CONSULTA_SALDO; LIDER_TURNO tambem opera o coletor (3a contagem, RF-
-- COL-060+, embora a tela de contagem em si seja COL-2). Gestao de
-- dispositivo e administrativa (mesmo criterio de PER.GESTAO_DISPOSITIVOS,
-- DOC-11): GESTOR_ARMAZEM.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('COL.OPERAR'), ('COL.CONSULTA_SALDO')) AS p(code)
WHERE r.code IN ('OPERADOR_EMPILHADEIRA', 'OPERADOR_PICKING', 'CONFERENTE', 'INVENTARIANTE', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'COL.DISPOSITIVO_GERIR', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- wms.field_device — RD-COL-001. GLOBAL (mesmo raciocinio de
-- wms.peripheral_device, DOC-11 migration 0061): o dispositivo e
-- infraestrutura do ARMAZEM, nao dado de tenant especifico.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.field_device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  user_agent TEXT,
  app_version TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_seen_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  battery_pct INT,
  blocked_at TIMESTAMPTZ,
  blocked_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT field_device_device_id_unique UNIQUE (device_id),
  CONSTRAINT field_device_status_check CHECK (status IN ('ACTIVE', 'BLOCKED')),
  CONSTRAINT field_device_battery_check CHECK (battery_pct IS NULL OR (battery_pct >= 0 AND battery_pct <= 100))
);

CREATE INDEX IF NOT EXISTS idx_field_device_warehouse ON wms.field_device(warehouse_id, status);

GRANT SELECT, INSERT, UPDATE ON wms.field_device TO wms_app;

-- =============================================================================
-- PIN de coletor (RF-SEG-004/RF-COL-030) — mesmo padrao ja usado para senha
-- (password_hash/failed_login_count/locked_until, migration 0015): hash
-- Argon2 (reaproveita PasswordService), contador de falhas, bloqueio.
-- =============================================================================
ALTER TABLE wms.user ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE wms.user ADD COLUMN IF NOT EXISTS pin_failed_count INT NOT NULL DEFAULT 0;
ALTER TABLE wms.user ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

-- =============================================================================
-- Parametros COL.* (SS7)
-- =============================================================================
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'COL.SCAN_TERMINADOR',  'Enter'),
  ('GLOBAL', 'COL.VERSAO_MINIMA',    '1.0.0'),
  ('GLOBAL', 'COL.FEEDBACK_SONORO',  'true')
ON CONFLICT DO NOTHING;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (66, 'DOC-15 COL-1: catalogo COL.*, wms.field_device (GLOBAL), PIN em wms.user, parametros COL.*', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
