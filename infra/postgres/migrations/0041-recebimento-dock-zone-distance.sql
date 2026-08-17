-- Migration: 0041
-- DOC-04 RF-REC-003 — REC.MAPA_DISTANCIA_DOCA_ZONA: matriz doca x zona em
-- metros. Não é um app_parameter escalar (mesma decisão de modelagem já
-- registrada na migration 0033) — tabela própria, GLOBAL (como wms.dock e
-- wms.zone, RN-DAD-004: nenhum dos dois tem tenant_id/RLS).

CREATE TABLE IF NOT EXISTS wms.dock_zone_distance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  dock_id UUID NOT NULL REFERENCES wms.dock(id) ON DELETE RESTRICT,
  zone_id UUID NOT NULL REFERENCES wms.zone(id) ON DELETE RESTRICT,
  distance_m NUMERIC(8,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT dock_zone_distance_unique UNIQUE (dock_id, zone_id),
  CONSTRAINT dock_zone_distance_positive CHECK (distance_m >= 0)
);

CREATE INDEX IF NOT EXISTS idx_dock_zone_distance_warehouse ON wms.dock_zone_distance (warehouse_id);

GRANT SELECT, INSERT, UPDATE ON wms.dock_zone_distance TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (41, 'DOC-04 RF-REC-003: dock_zone_distance (GLOBAL) - matriz doca x zona em metros para sugestao de doca', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
