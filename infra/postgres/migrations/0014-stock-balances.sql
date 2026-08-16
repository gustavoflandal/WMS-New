-- Migration: 0014
-- DOC-02 §5.5 — Estrutura dos saldos (DE TENANT, RN-DAD-004: tenant_id =
-- client.id, RLS obrigatorio). stock_balance, fiscal_stock_balance,
-- stock_movement. Regras de MOVIMENTACAO (como as parcelas mudam) sao do
-- DOC-05 -- aqui so a estrutura + CHECKs de integridade (RG-004, RG-014).

-- =============================================================================
-- stock_balance — DOC-02 §5.5
-- UNIQUE(tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id)
-- CHECK >= 0 em todas as 6 parcelas (RG-004). fillfactor 85 (RNF-ARQ-091).
-- Nota: batch_id/pallet_id sao nullable -- por semantica padrao do Postgres,
-- NULL != NULL em UNIQUE, entao duas linhas com a mesma combinacao exceto
-- ambas com batch_id/pallet_id NULL NAO violam a constraint (comportamento
-- padrao do banco, nao inventado aqui; DOC-02 nao discute esse caso).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.stock_balance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  logical_warehouse_id UUID REFERENCES wms.logical_warehouse(id) ON DELETE RESTRICT,
  overflow_flag BOOLEAN NOT NULL DEFAULT FALSE,
  qty_available NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_reserved NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_blocked NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_quarantine NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_damaged NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_in_transit NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT stock_balance_unique UNIQUE (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id),
  CONSTRAINT stock_balance_qty_available_check CHECK (qty_available >= 0),
  CONSTRAINT stock_balance_qty_reserved_check CHECK (qty_reserved >= 0),
  CONSTRAINT stock_balance_qty_blocked_check CHECK (qty_blocked >= 0),
  CONSTRAINT stock_balance_qty_quarantine_check CHECK (qty_quarantine >= 0),
  CONSTRAINT stock_balance_qty_damaged_check CHECK (qty_damaged >= 0),
  CONSTRAINT stock_balance_qty_in_transit_check CHECK (qty_in_transit >= 0)
) WITH (fillfactor = 85);

CREATE INDEX IF NOT EXISTS idx_stock_balance_tenant_product_warehouse
  ON wms.stock_balance (tenant_id, product_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_balance_location
  ON wms.stock_balance (location_id);
CREATE INDEX IF NOT EXISTS idx_stock_balance_pallet
  ON wms.stock_balance (pallet_id);
CREATE INDEX IF NOT EXISTS idx_stock_balance_overflow
  ON wms.stock_balance (overflow_flag) WHERE overflow_flag = true;

-- RN-DAD-020: "QUANDO requires_batch = true, toda movimentacao DEVE
-- informar lote". Sem motor de movimentacao nesta sessao (DOC-05), o ponto
-- de aplicacao disponivel em DOC-02/2B e a propria criacao de saldo.
CREATE OR REPLACE FUNCTION wms.check_stock_balance_batch_required()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_requires_batch BOOLEAN;
BEGIN
  SELECT ps.requires_batch INTO v_requires_batch
  FROM wms.product p
  JOIN wms.product_species ps ON ps.code = p.species_code
  WHERE p.id = NEW.product_id;

  IF v_requires_batch AND NEW.batch_id IS NULL THEN
    RAISE EXCEPTION 'RN-DAD-020: batch is required for this product species'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_balance_batch_required
  BEFORE INSERT OR UPDATE ON wms.stock_balance
  FOR EACH ROW EXECUTE FUNCTION wms.check_stock_balance_batch_required();

ALTER TABLE wms.stock_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_balance FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_balance_tenant_isolation ON wms.stock_balance;
CREATE POLICY stock_balance_tenant_isolation ON wms.stock_balance
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.stock_balance TO wms_app;

-- RN-DAD-020: "E PROIBIDO alterar species_code de produto com saldo > 0".
-- Trigger adicionado aqui (nao na migration 0011) porque depende de
-- wms.stock_balance, que so passa a existir nesta migration.
CREATE OR REPLACE FUNCTION wms.prevent_species_change_with_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_has_balance BOOLEAN;
BEGIN
  IF NEW.species_code IS DISTINCT FROM OLD.species_code THEN
    SELECT EXISTS (
      SELECT 1 FROM wms.stock_balance sb
      WHERE sb.product_id = NEW.id
        AND (sb.qty_available + sb.qty_reserved + sb.qty_blocked + sb.qty_quarantine + sb.qty_damaged + sb.qty_in_transit) > 0
    ) INTO v_has_balance;

    IF v_has_balance THEN
      RAISE EXCEPTION 'RN-DAD-020: species_code cannot change while product has stock balance > 0'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_species_immutable_with_balance
  BEFORE UPDATE ON wms.product
  FOR EACH ROW EXECUTE FUNCTION wms.prevent_species_change_with_balance();

-- =============================================================================
-- fiscal_stock_balance — DOC-02 §5.5, RG-014
-- UNIQUE(tenant_id, warehouse_id, product_id, storage_remittance_invoice_id)
-- CHECK qty_consumed <= qty_credited. Saldo fiscal disponivel = qty_credited
-- - qty_consumed, SEMPRE calculado (nunca coluna persistida) -- nao ha
-- coluna "qty_available" nesta tabela por design.
-- [LACUNA: storage_remittance_invoice e tabela do DOC-08 (fiscal), fora do
-- escopo desta sessao -- storage_remittance_invoice_id fica sem FK ate essa
-- tabela existir.]
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.fiscal_stock_balance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  storage_remittance_invoice_id UUID NOT NULL,
  qty_credited NUMERIC(18,6) NOT NULL,
  qty_consumed NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT fiscal_stock_balance_unique UNIQUE (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id),
  CONSTRAINT fiscal_stock_balance_credited_check CHECK (qty_credited >= 0),
  CONSTRAINT fiscal_stock_balance_consumed_check CHECK (qty_consumed >= 0),
  CONSTRAINT fiscal_stock_balance_consumed_le_credited CHECK (qty_consumed <= qty_credited)
);

ALTER TABLE wms.fiscal_stock_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.fiscal_stock_balance FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fiscal_stock_balance_tenant_isolation ON wms.fiscal_stock_balance;
CREATE POLICY fiscal_stock_balance_tenant_isolation ON wms.fiscal_stock_balance
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.fiscal_stock_balance TO wms_app;

-- =============================================================================
-- stock_movement — DOC-02 §5.5; particionada mensal (RNF-ARQ-090),
-- append-only (UPDATE/DELETE PROIBIDOS -- revogado explicitamente de
-- wms_app, nao basta a ausencia de metodo no service).
-- [LACUNA: "movement_type — catalogo fechado definido no DOC-05" -- fora do
-- escopo desta sessao, sem CHECK de enum ainda (coluna TEXT NOT NULL).]
-- [LACUNA: "parcela de saldo de/para" -- DOC-02 nao da nomes de coluna
-- exatos; modelado aqui como balance_bucket_from/to (TEXT), com CHECK
-- restrito aos 6 nomes das parcelas de stock_balance ja definidas nesta
-- mesma secao do documento (AVAILABLE/RESERVED/BLOCKED/QUARANTINE/DAMAGED/
-- IN_TRANSIT) -- e uma inferencia direta das 6 colunas qty_* documentadas,
-- nao um valor novo inventado, mas o NOME da coluna em si pode divergir de
-- uma definicao futura do DOC-05.]
-- =============================================================================
-- RN-DAD-006: FKs sempre ON DELETE RESTRICT. document_ref_id/task_id/
-- requirement_id ficam sem FK -- tabelas de documento/tarefa nao existem
-- nesta sessao (DOC-03/04/06/07), ja documentado como [LACUNA] acima.
CREATE TABLE IF NOT EXISTS wms.stock_movement (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  location_id_from UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  location_id_to UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id_from UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  pallet_id_to UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  balance_bucket_from TEXT,
  balance_bucket_to TEXT,
  qty NUMERIC(18,6) NOT NULL,
  document_ref_type TEXT,
  document_ref_id UUID,
  task_id UUID,
  requirement_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT stock_movement_qty_positive CHECK (qty > 0),
  CONSTRAINT stock_movement_bucket_from_check CHECK (
    balance_bucket_from IS NULL OR balance_bucket_from IN ('AVAILABLE', 'RESERVED', 'BLOCKED', 'QUARANTINE', 'DAMAGED', 'IN_TRANSIT')
  ),
  CONSTRAINT stock_movement_bucket_to_check CHECK (
    balance_bucket_to IS NULL OR balance_bucket_to IN ('AVAILABLE', 'RESERVED', 'BLOCKED', 'QUARANTINE', 'DAMAGED', 'IN_TRANSIT')
  )
) PARTITION BY RANGE (occurred_at);

-- Cria (idempotente) a particao mensal wms.stock_movement_yYYYY_mMM e ja
-- revoga UPDATE/DELETE nela (append-only tambem no filho -- particoes
-- criadas via CREATE TABLE ... PARTITION OF recebem o default privilege do
-- schema (migration 0010: SELECT/INSERT/UPDATE) de forma independente do
-- pai, entao UPDATE precisa ser revogado explicitamente em CADA particao,
-- nao so no pai). Reaproveitada pelo job de particionamento do scheduler
-- (RNF-ARQ-090, Entregavel 9).
-- SECURITY DEFINER: wms_app só tem USAGE no schema wms (migration 0001),
-- não CREATE — o CREATE TABLE (partição) precisa rodar com o privilégio de
-- quem definiu a função (a role de bootstrap das migrations), não do
-- chamador. search_path fixo evita hijacking (boa prática para
-- SECURITY DEFINER).
CREATE OR REPLACE FUNCTION wms.ensure_stock_movement_partition(p_year INT, p_month INT)
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
  v_partition_name := format('stock_movement_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.stock_movement FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    EXECUTE format('REVOKE UPDATE, DELETE ON wms.%I FROM wms_app', v_partition_name);
    EXECUTE format('GRANT SELECT, INSERT ON wms.%I TO wms_app', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

-- Bootstrap: particao do mes corrente + do mes seguinte (a manutencao
-- continua e responsabilidade do job do scheduler, Entregavel 9/RNF-ARQ-090).
DO $$
DECLARE
  v_now DATE := CURRENT_DATE;
  v_next DATE := (CURRENT_DATE + INTERVAL '1 month')::date;
BEGIN
  PERFORM wms.ensure_stock_movement_partition(EXTRACT(YEAR FROM v_now)::int, EXTRACT(MONTH FROM v_now)::int);
  PERFORM wms.ensure_stock_movement_partition(EXTRACT(YEAR FROM v_next)::int, EXTRACT(MONTH FROM v_next)::int);
END
$$;

ALTER TABLE wms.stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_movement FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_movement_tenant_isolation ON wms.stock_movement;
CREATE POLICY stock_movement_tenant_isolation ON wms.stock_movement
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

-- append-only (DOC-02 §5.5: "E PROIBIDO UPDATE/DELETE nesta tabela") --
-- explicito mesmo com o default privilege da migration 0010 ja sem DELETE,
-- porque UPDATE ainda faz parte do default e precisa ser negado aqui.
GRANT SELECT, INSERT ON wms.stock_movement TO wms_app;
REVOKE UPDATE, DELETE ON wms.stock_movement FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (14, 'DOC-02 stock balances: stock_balance, fiscal_stock_balance, stock_movement (TENANT, RLS, partitioned, append-only)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
