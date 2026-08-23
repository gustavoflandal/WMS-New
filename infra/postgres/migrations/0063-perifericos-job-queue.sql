-- Migration: 0063
-- DOC-11 RNF-PER-002/RD-PER-003 — peripheral_job: fila/protocolo real do
-- Edge Agent, particionada mensalmente (RNF-ARQ-090, mesmo padrão de
-- wms.audit_log — migration 0019). SUBSTITUI wms.edge_agent_job (migration
-- 0007, "Drivers per peripheral são out of scope (DOC-11 session)" — é
-- exatamente esta sessão) como fila efetiva: os estados/envelope de
-- edge_agent_job (EM_PROGRESSO/COMPLETADO/ERRO) não batem com o protocolo
-- exato exigido por RNF-PER-002 (ENVIADO/EXECUTANDO/CONCLUIDO/FALHA/
-- EXPIRADO) e a tabela nunca teve um consumidor real (só 2 INSERTs em SQL
-- cru em gate-in/gate-out, nenhum service, nenhum WORKER que a lesse) — sem
-- dado real em produção, migrar para o schema correto agora custa menos do
-- que carregar dois modelos de fila divergentes para sempre. edge_agent_job
-- é removida (DROP) nesta migration; os 2 chamadores são atualizados no
-- mesmo commit desta sessão para usar PeripheralJobService/peripheral_job.
--
-- Classificação GLOBAL (DOC-11 §7, mesmo raciocínio de 0061/0062):
-- tenant_id é mantido como coluna informativa (rastreabilidade do evento de
-- negócio que originou o job), SEM RLS — o controle de acesso é por
-- permissão WAREHOUSE (PER.*) mediada pelos services, não por tenant_id da
-- linha (o mesmo dispositivo físico serve jobs de vários tenants).

DROP TABLE IF EXISTS wms.edge_agent_job;

CREATE TABLE wms.peripheral_job (
  job_id UUID NOT NULL DEFAULT gen_random_uuid(),
  edge_agent_id UUID NOT NULL REFERENCES wms.edge_agent(edge_agent_id) ON DELETE RESTRICT,
  peripheral_device_id UUID NOT NULL REFERENCES wms.peripheral_device(id) ON DELETE RESTRICT,
  device_code TEXT NOT NULL,
  job_type TEXT NOT NULL,
  tenant_id UUID,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  payload JSONB NOT NULL DEFAULT '{}',
  timeout_ms INT NOT NULL DEFAULT 15000,
  state TEXT NOT NULL DEFAULT 'PENDENTE',
  result JSONB,
  error_code TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  -- RF-PER-021: identifica QUAL entidade física esta etiqueta representa
  -- (pallet, package, location...) — usado para contar quantas vezes ela já
  -- foi impressa e derivar a marca RE1/RE2/... em reimpressões. Preenchido
  -- em TODO job PRINT_ZPL de etiqueta (não só reimpressões); sem FK própria
  -- (`print_entity_id` é o id textual da entidade, tabela variável conforme
  -- `print_entity`).
  print_entity TEXT,
  print_entity_id TEXT,
  reprint_seq INT NOT NULL DEFAULT 0,
  label_template_id UUID REFERENCES wms.label_template(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_id, created_at),
  CONSTRAINT peripheral_job_type_check CHECK (job_type IN ('PRINT_ZPL', 'PRINT_PDF', 'WEIGH', 'GATE_OPEN', 'LPR_STATUS')),
  CONSTRAINT peripheral_job_state_check CHECK (state IN ('PENDENTE', 'ENVIADO', 'EXECUTANDO', 'CONCLUIDO', 'FALHA', 'EXPIRADO')),
  CONSTRAINT peripheral_job_error_code_check CHECK (error_code IS NULL OR error_code IN (
    'DEVICE_OFFLINE', 'TIMEOUT', 'PROTOCOL_ERROR', 'PAPER_OUT', 'RIBBON_OUT', 'SERIAL_UNAVAILABLE'
  )),
  -- §5.1 [INVIOLÁVEL]: retry automático só para PRINT_*.
  CONSTRAINT peripheral_job_no_auto_retry_weigh_gate CHECK (
    job_type IN ('PRINT_ZPL', 'PRINT_PDF') OR retry_count = 0
  )
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_peripheral_job_agent_pending
  ON wms.peripheral_job(edge_agent_id, created_at)
  WHERE state = 'PENDENTE';

CREATE INDEX IF NOT EXISTS idx_peripheral_job_inflight_timeout
  ON wms.peripheral_job(state, issued_at)
  WHERE state IN ('ENVIADO', 'EXECUTANDO');

CREATE INDEX IF NOT EXISTS idx_peripheral_job_expiring
  ON wms.peripheral_job(state, expires_at)
  WHERE state = 'PENDENTE';

CREATE INDEX IF NOT EXISTS idx_peripheral_job_print_entity
  ON wms.peripheral_job(print_entity, print_entity_id, created_at DESC)
  WHERE print_entity IS NOT NULL;

-- Mesmo padrão de wms.ensure_audit_log_partition (migration 0019):
-- SECURITY DEFINER (wms_app só tem USAGE no schema, não CREATE). Job NÃO é
-- append-only (state/result/retry_count mudam ao longo do ciclo de vida) —
-- GRANT SELECT/INSERT/UPDATE no filho, diferente do padrão append-only de
-- audit_log.
CREATE OR REPLACE FUNCTION wms.ensure_peripheral_job_partition(p_year INT, p_month INT)
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
  v_partition_name := format('peripheral_job_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.peripheral_job FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON wms.%I TO wms_app', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

DO $$
DECLARE
  v_now DATE := CURRENT_DATE;
  v_next DATE := (CURRENT_DATE + INTERVAL '1 month')::date;
BEGIN
  PERFORM wms.ensure_peripheral_job_partition(EXTRACT(YEAR FROM v_now)::int, EXTRACT(MONTH FROM v_now)::int);
  PERFORM wms.ensure_peripheral_job_partition(EXTRACT(YEAR FROM v_next)::int, EXTRACT(MONTH FROM v_next)::int);
END
$$;

GRANT SELECT, INSERT, UPDATE ON wms.peripheral_job TO wms_app;

-- ---------------------------------------------------------------------------
-- [CONFLITO: DOC-11 RNF-PER-001 vs migration 0007] — RNF-PER-001 é
-- explícito: "Um armazém PODE ter N agents" (agent é recurso de
-- INFRAESTRUTURA DO ARMAZÉM, como peripheral_device/workstation acima).
-- A migration 0007 (Sessão 1, anterior ao DOC-11 existir — comentário da
-- própria migration: "Drivers per peripheral são out of scope (DOC-11
-- session)") deu a wms.edge_agent tenant_id NOT NULL + RLS por tenant, o
-- que tornaria um agent cadastrado sob o tenant A invisível para uma
-- operação do tenant B no MESMO armazém — incompatível com "N agents por
-- armazém" (não há noção de agent "do cliente X"). Corrigido na origem
-- (mesmo princípio já registrado em CLAUDE.md/[[wms-root-cause-not-callers]]:
-- corrigir a regra de acesso na fonte, não em cada chamador) — edge_agent
-- passa a ser GLOBAL, como peripheral_device/workstation/peripheral_job
-- acima. Nenhum dado de produção existe para este recurso (não usado por
-- nenhum fluxo real até esta sessão), então a coluna é removida direto.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS edge_agent_tenant_isolation ON wms.edge_agent;
ALTER TABLE wms.edge_agent DISABLE ROW LEVEL SECURITY;
ALTER TABLE wms.edge_agent DROP COLUMN tenant_id;

-- ---------------------------------------------------------------------------
-- RNF-PER-001: "autentica-se por token de dispositivo (hash em edge_agent,
-- RD-ARQ-003)". A migration 0007 armazenava `token` em texto plano — nenhum
-- agent real foi pareado até hoje (0 consumidores fora deste service), então
-- não há dado de produção a migrar: coluna trocada diretamente por
-- token_hash (SHA-256 do token, calculado em Node antes do INSERT — mesmo
-- raciocínio de token de API key, não senha de humano: alta entropia
-- (32 bytes aleatórios) dispensa hash lento tipo Argon2, que é para
-- resistir a força bruta sobre senhas de baixa entropia — ver
-- PasswordService).
-- ---------------------------------------------------------------------------
ALTER TABLE wms.edge_agent DROP COLUMN token;
ALTER TABLE wms.edge_agent ADD COLUMN token_hash TEXT;
UPDATE wms.edge_agent SET token_hash = encode(sha256(edge_agent_id::text::bytea), 'hex') WHERE token_hash IS NULL;
ALTER TABLE wms.edge_agent ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE wms.edge_agent ADD CONSTRAINT edge_agent_token_hash_unique UNIQUE (token_hash);
DROP INDEX IF EXISTS idx_edge_agent_token;
CREATE INDEX IF NOT EXISTS idx_edge_agent_token_hash ON wms.edge_agent(token_hash);

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (63, 'DOC-11: peripheral_job (particionada mensal, substitui edge_agent_job) + edge_agent.token_hash', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
