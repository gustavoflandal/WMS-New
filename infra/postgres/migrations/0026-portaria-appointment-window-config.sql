-- Migration: 0026
-- DOC-03 RD-POR-007 — appointment_window_config (GLOBAL, RN-DAD-004):
-- janelas por armazem/dia da semana, capacidade por sentido (ver nota de
-- modelagem sobre POR.JANELA_CAPACIDADE na migration 0023).

CREATE TABLE IF NOT EXISTS wms.appointment_window_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  -- weekday: 0=domingo..6=sabado. [LACUNA: DOC-03 nao especifica a
  -- convencao numerica de dia da semana] — adotado o padrao ISO/JS
  -- Date.getDay() (0=domingo), documentado aqui em vez de inventado
  -- silenciosamente.
  weekday SMALLINT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  direction TEXT NOT NULL,
  capacity INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT appointment_window_config_unique UNIQUE (warehouse_id, weekday, start_time, end_time, direction),
  CONSTRAINT appointment_window_config_weekday_check CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT appointment_window_config_time_check CHECK (end_time > start_time),
  CONSTRAINT appointment_window_config_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  CONSTRAINT appointment_window_config_capacity_check CHECK (capacity > 0),
  CONSTRAINT appointment_window_config_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE INDEX IF NOT EXISTS idx_appointment_window_config_warehouse ON wms.appointment_window_config (warehouse_id, weekday);

GRANT SELECT, INSERT, UPDATE ON wms.appointment_window_config TO wms_app;
-- RN-POR-004: worker de no-show precisa ler a janela (fim + tolerancia) cross-tenant.
GRANT SELECT ON wms.appointment_window_config TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (26, 'DOC-03 RD-POR-007: appointment_window_config (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
