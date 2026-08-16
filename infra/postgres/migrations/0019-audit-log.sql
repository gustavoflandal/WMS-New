-- Migration: 0019
-- DOC-12 §4.4 [INVIOLÁVEL] — audit_log (RD-SEG-030), particionada mensal
-- (RNF-ARQ-090), append-only (RN-SEG-031: wms_app possui APENAS INSERT e
-- SELECT — UPDATE/DELETE revogados no banco).
--
-- [CONFLITO/LACUNA identificado nesta sessão]: RD-SEG-030 declara
-- `warehouse_id` como NOT NULL ("warehouse_id, user_id — uuid [N]"), mas
-- RN-SEG-032 exige auditar LOGIN/LOGOUT e falhas de autenticação — eventos
-- que estruturalmente ocorrem ANTES de qualquer seleção de armazém pelo
-- usuário (não há armazém "atual" no momento do login). Forçar NOT NULL
-- exigiria inventar um valor sentinela de warehouse_id para login/logout,
-- o que seria pior do que documentar a exceção: `warehouse_id` foi
-- implementado NULLABLE aqui, desviando do literal do documento apenas
-- para esta classe de evento (login/logout/refresh), com o motivo
-- registrado neste comentário em vez de um valor inventado no dado.

-- =============================================================================
-- audit_log — RD-SEG-030
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id UUID,                      -- NULL apenas em eventos de tabelas globais (RD-SEG-030)
  warehouse_id UUID REFERENCES wms.warehouse(id) ON DELETE RESTRICT, -- NULLABLE — ver nota acima (login/logout)
  user_id UUID NOT NULL REFERENCES wms.user(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL,
  device_id TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  requirement_id TEXT,
  before JSONB,
  after JSONB,
  reason TEXT,
  correlation_id UUID,
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_log_origin_check CHECK (origin IN ('WEB', 'PWA', 'PORTAL', 'API', 'EDGE', 'SCHEDULER', 'SYNC')),
  CONSTRAINT audit_log_action_check CHECK (action IN (
    'CREATE', 'UPDATE', 'STATUS_CHANGE', 'MOVE', 'APPROVE', 'REJECT', 'OVERRIDE',
    'LOGIN', 'LOGOUT', 'EXPORT', 'PRINT'
  )),
  -- warehouse_id só pode ser omitido para LOGIN/LOGOUT (ver nota de
  -- desvio no topo do arquivo) — para as demais ações, RD-SEG-030 é
  -- respeitado literalmente (NOT NULL).
  CONSTRAINT audit_log_warehouse_required_check CHECK (
    action IN ('LOGIN', 'LOGOUT') OR warehouse_id IS NOT NULL
  )
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON wms.audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON wms.audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation ON wms.audit_log (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_warehouse ON wms.audit_log (warehouse_id, occurred_at DESC) WHERE warehouse_id IS NOT NULL;

-- Mesmo padrão de wms.ensure_stock_movement_partition (Sessão 2B,
-- migration 0014): SECURITY DEFINER porque wms_app só tem USAGE no schema,
-- não CREATE. Reaproveitado pelo job de particionamento (Entregável 4:
-- "registre a partição de audit_log no job já existente").
CREATE OR REPLACE FUNCTION wms.ensure_audit_log_partition(p_year INT, p_month INT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wms, pg_temp
AS $$
DECLARE
  v_partition_name TEXT;
  v_start DATE;
  v_end DATE;
BEGIN
  v_partition_name := format('audit_log_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.audit_log FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    -- RN-SEG-031: append-only tambem no filho (cada particao recebe o
    -- default privilege do schema — migration 0010 — de forma
    -- independente do pai).
    EXECUTE format('REVOKE UPDATE, DELETE ON wms.%I FROM wms_app', v_partition_name);
    EXECUTE format('GRANT SELECT, INSERT ON wms.%I TO wms_app', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

-- Bootstrap: partição do mês corrente + do mês seguinte (mesmo critério de
-- stock_movement — a manutenção contínua é do job do scheduler).
DO $$
DECLARE
  v_now DATE := CURRENT_DATE;
  v_next DATE := (CURRENT_DATE + INTERVAL '1 month')::date;
BEGIN
  PERFORM wms.ensure_audit_log_partition(EXTRACT(YEAR FROM v_now)::int, EXTRACT(MONTH FROM v_now)::int);
  PERFORM wms.ensure_audit_log_partition(EXTRACT(YEAR FROM v_next)::int, EXTRACT(MONTH FROM v_next)::int);
END
$$;

-- RN-SEG-031: append-only — SELECT/INSERT apenas, UPDATE/DELETE revogados
-- explicitamente (mesmo já sem DELETE por padrão desde a migration 0010).
GRANT SELECT, INSERT ON wms.audit_log TO wms_app;
REVOKE UPDATE, DELETE ON wms.audit_log FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (19, 'DOC-12 audit trail: audit_log (GLOBAL, partitioned, append-only)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
