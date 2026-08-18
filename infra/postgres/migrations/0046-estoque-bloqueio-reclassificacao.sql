-- Migration: 0046
-- DOC-05 §4.4 — Entregável 3: RF-EST-030 (bloqueio/desbloqueio manual, motivo
-- tipificado) e RF-EST-031 (reclassificação para avaria + descarte via
-- exceção EST.DESCARTE_SALDO, 2 passos).
--
-- [LACUNA] DOC-05 §7 (RD-EST-*) não modela uma coluna/tabela específica para
-- o "motivo tipificado" de RF-EST-030 nem para o registro de reclassificação/
-- descarte de RF-EST-031 — inferência desta sessão, seguindo o MESMO padrão
-- já usado por wms.discrepancy (migration 0038, DOC-04 RD-REC-004): tabela
-- própria com vínculo a wms.operational_exception, fotos como TEXT[] com
-- CHECK de cardinalidade, status PENDING/RESOLVED.

-- =============================================================================
-- 0. Correção de bug real encontrado ao testar RF-EST-030: wms.stock_balance_
-- unique (migration 0014) é uma UNIQUE comum — por padrão do Postgres (antes
-- de NULLS NOT DISTINCT, PG15+), NULL nunca é considerado igual a NULL para
-- fins de unicidade/ON CONFLICT. Como batch_id/pallet_id são NULLable (saldo
-- sem lote/palete é o caso normal para muitos produtos), StockMovementService
-- .credit() (INSERT ... ON CONFLICT (tenant_id,warehouse_id,product_id,
-- batch_id,location_id,pallet_id) DO UPDATE) NUNCA batia contra uma linha
-- existente com batch_id/pallet_id NULL — cada crédito criava uma linha NOVA
-- em vez de somar na existente, quebrando RG-004 ("um saldo por combinação")
-- silenciosamente sempre que o mesmo endereço/produto sem lote/palete recebia
-- mais de um crédito (ex.: BLOQUEIO logo seguido de DESBLOQUEIO no mesmo
-- endereço). Descoberto pelo teste de integração desta sessão (RF-EST-030).
-- Corrigido recriando a UNIQUE com NULLS NOT DISTINCT (suportado desde
-- PG15; imagem deste projeto é postgres:16-alpine).
--
-- CONSOLIDAÇÃO PRÉVIA (obrigatória antes do ALTER): um banco que já existia
-- ANTES desta migration pode ter linhas duplicadas de verdade — exatamente
-- o efeito do bug (cada crédito repetido virava linha nova em vez de somar).
-- Aplicar a UNIQUE NULLS NOT DISTINCT direto nesse banco falharia com
-- "duplicate key value violates unique constraint" na hora do ALTER. O bloco
-- abaixo funde essas linhas ANTES de criar a constraint: agrupa por chave
-- (comparação NULL-safe via IS NOT DISTINCT FROM, o mesmo critério que a
-- nova constraint vai usar), soma as 6 parcelas na linha mais antiga do
-- grupo (created_at asc, id asc como desempate) e apaga as demais.
-- Idempotente: se não há duplicata (banco novo, ou já rodou uma vez), a
-- CTE `grouped` não produz linhas (HAVING COUNT(*) > 1) e o bloco é um no-op.
-- =============================================================================
-- A consolidação abaixo é uma escrita direta em wms.stock_balance — o
-- trigger de guarda (RN-EST-001, seção 3 desta migration, já ativo desde a
-- 0045) rejeitaria com ERRCODE 42501 sem esta autorização explícita. LOCAL
-- ao escopo da transação (o MigrationRunner real, apps/backend/src/core/
-- database/migration.runner.ts, executa o arquivo INTEIRO dentro de um único
-- BEGIN/COMMIT — expira sozinho no COMMIT, mesmo padrão usado em
-- StockMovementService.apply()).
SELECT set_config('app.stock_movement_authorized', 'true', true);

DO $$
DECLARE
  v_merged INT;
BEGIN
  WITH grouped AS (
    SELECT
      tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id,
      SUM(qty_available) AS sum_available,
      SUM(qty_reserved) AS sum_reserved,
      SUM(qty_blocked) AS sum_blocked,
      SUM(qty_quarantine) AS sum_quarantine,
      SUM(qty_damaged) AS sum_damaged,
      SUM(qty_in_transit) AS sum_in_transit,
      (array_agg(id ORDER BY created_at ASC, id ASC))[1] AS keep_id
    FROM wms.stock_balance
    GROUP BY tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id
    HAVING COUNT(*) > 1
  ),
  applied_update AS (
    UPDATE wms.stock_balance sb
    SET qty_available = g.sum_available,
        qty_reserved = g.sum_reserved,
        qty_blocked = g.sum_blocked,
        qty_quarantine = g.sum_quarantine,
        qty_damaged = g.sum_damaged,
        qty_in_transit = g.sum_in_transit,
        updated_at = now()
    FROM grouped g
    WHERE sb.id = g.keep_id
    RETURNING sb.id
  ),
  applied_delete AS (
    DELETE FROM wms.stock_balance sb
    USING grouped g
    WHERE sb.tenant_id = g.tenant_id
      AND sb.warehouse_id = g.warehouse_id
      AND sb.product_id = g.product_id
      AND sb.batch_id IS NOT DISTINCT FROM g.batch_id
      AND sb.location_id = g.location_id
      AND sb.pallet_id IS NOT DISTINCT FROM g.pallet_id
      AND sb.id <> g.keep_id
    RETURNING sb.id
  )
  SELECT COUNT(*) INTO v_merged FROM applied_delete;

  IF v_merged > 0 THEN
    RAISE NOTICE 'RG-004: % linha(s) duplicada(s) de wms.stock_balance consolidada(s) (SUM das parcelas) antes de aplicar UNIQUE NULLS NOT DISTINCT.', v_merged;
  END IF;
END
$$;

ALTER TABLE wms.stock_balance DROP CONSTRAINT IF EXISTS stock_balance_unique;
ALTER TABLE wms.stock_balance ADD CONSTRAINT stock_balance_unique
  UNIQUE NULLS NOT DISTINCT (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id);

-- =============================================================================
-- 1. RF-EST-030 — motivo tipificado em wms.stock_movement (BLOQUEIO/DESBLOQUEIO)
-- =============================================================================
ALTER TABLE wms.stock_movement ADD COLUMN IF NOT EXISTS block_reason_code TEXT REFERENCES wms.stock_block_reason(code);
ALTER TABLE wms.stock_movement ADD COLUMN IF NOT EXISTS block_reason_text TEXT;
-- "OUTRO exige texto livre" (RF-EST-030, RD-EST-004) é validado no nível da
-- app (StockBlockService), não aqui: um CHECK cruzando com outra tabela
-- (stock_block_reason.requires_text) exigiria uma função extra só para isso
-- e stock_movement.movement_type nem sempre é BLOQUEIO/DESBLOQUEIO (a coluna
-- é NULL para os outros 16 tipos) — a app já valida o catálogo antes de
-- chamar StockMovementService.apply().

-- =============================================================================
-- 2. RF-EST-031 — wms.stock_reclassification (RECLASSIFICACAO_AVARIA + DESCARTE)
-- Uma única tabela para os dois fluxos do mesmo requisito (§4.4 RF-EST-031),
-- mesmo espírito multi-tipo já usado por wms.discrepancy para FALTA/SOBRA/
-- AVARIA/TROCA. RECLASSIFICACAO_AVARIA é aplicada IMEDIATAMENTE (permissão +
-- fotos, sem exceção — "reflexo" da §4.4, que só exige exceção para
-- DESCARTE); a linha nasce já RESOLVED/APPLIED. DESCARTE nasce PENDING,
-- vinculada a uma wms.operational_exception EST.DESCARTE_SALDO (2 passos), e
-- só é resolvida quando essa exceção decide (APPROVED -> DISCARDED, REJECTED
-- -> REJECTED) — mesmo fluxo de CheckingService.decideDiscrepancy (DOC-04).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.stock_reclassification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  request_type TEXT NOT NULL,
  from_bucket TEXT NOT NULL,
  qty NUMERIC(18,6) NOT NULL,
  photo_keys TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  resolution TEXT,
  operational_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  -- wms.stock_movement tem PK composta (id, occurred_at) por ser particionada
  -- (migration 0014) — não dá para referenciar (id) sozinho com FK. Guardado
  -- sem FK, mesmo padrão já documentado para requirement_id em
  -- ApplyMovementParams (stock-movement.service.ts).
  movement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  CONSTRAINT stock_reclassification_type_check CHECK (request_type IN ('RECLASSIFICACAO_AVARIA', 'DESCARTE')),
  CONSTRAINT stock_reclassification_from_bucket_check CHECK (from_bucket IN ('AVAILABLE', 'BLOCKED', 'DAMAGED')),
  CONSTRAINT stock_reclassification_qty_check CHECK (qty > 0),
  CONSTRAINT stock_reclassification_status_check CHECK (status IN ('PENDING', 'RESOLVED')),
  CONSTRAINT stock_reclassification_resolution_check CHECK (resolution IS NULL OR resolution IN ('APPLIED', 'DISCARDED', 'REJECTED')),
  -- RF-EST-031: "fotos obrigatórias como no DOC-04" — só para a
  -- reclassificação de avaria (mesmo cuidado de cardinality() vs
  -- array_length() já documentado na migration 0038 para não deixar
  -- photo_keys='{}' passar silenciosamente).
  CONSTRAINT stock_reclassification_avaria_requires_photo CHECK (request_type != 'RECLASSIFICACAO_AVARIA' OR cardinality(photo_keys) >= 1)
  -- RF-EST-031: "Descarte físico exige exceção EST.DESCARTE_SALDO" —
  -- NÃO modelado como CHECK NOT NULL na própria linha: a exceção só existe
  -- DEPOIS do INSERT (mesmo padrão de duas fases de wms.discrepancy/DOC-04 —
  -- INSERT da linha de domínio, DEPOIS OperationalExceptionService.create()
  -- com entityId = id da linha, DEPOIS UPDATE do vínculo). wms.discrepancy
  -- também não tem essa CHECK pelo mesmo motivo. Garantido pela app
  -- (StockReclassificationService.requestDiscard), não pelo banco.
);

CREATE INDEX IF NOT EXISTS idx_stock_reclassification_tenant ON wms.stock_reclassification (tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_reclassification_exception ON wms.stock_reclassification (operational_exception_id);

ALTER TABLE wms.stock_reclassification ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_reclassification FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_reclassification_tenant_isolation ON wms.stock_reclassification;
CREATE POLICY stock_reclassification_tenant_isolation ON wms.stock_reclassification
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.stock_reclassification TO wms_app;

-- =============================================================================
-- 3. RN-EST-014 (Entregável 4) — grants ADR-006/wms_worker: ExpirationService
-- roda cross-tenant via transactionAsWorker (mesmo padrão já usado por
-- CrossDockAgingWorkerImpl/migration 0040) e precisa ler wms.batch (nunca
-- concedido a wms_worker antes) e escrever saldo via StockMovementService
-- (que roda NO MESMO client do worker — wms_worker também precisa dos
-- privilégios de tabela que wms_app já tinha em wms.stock_balance/
-- stock_movement, migration 0014). Least privilege: só o que o job usa.
-- =============================================================================
GRANT SELECT ON wms.batch TO wms_worker;
GRANT SELECT, INSERT, UPDATE ON wms.stock_balance TO wms_worker;
GRANT SELECT, INSERT ON wms.stock_movement TO wms_worker;
-- wms.check_stock_balance_batch_required() (trigger RN-DAD-020, migration
-- 0014) NÃO é SECURITY DEFINER — roda com o privilégio de quem faz o INSERT/
-- UPDATE em stock_balance, então wms_worker também precisa ler as tabelas
-- que essa função consulta.
GRANT SELECT ON wms.product TO wms_worker;
GRANT SELECT ON wms.product_species TO wms_worker;

-- wms.stock_movement é particionada (RNF-ARQ-090) — GRANT no pai NÃO
-- propaga para as partições (mesmo motivo já documentado na migration 0014
-- para o REVOKE de UPDATE/DELETE: cada partição criada via CREATE TABLE...
-- PARTITION OF recebe o DEFAULT PRIVILEGE do schema, independente do pai).
-- 1) partições JÁ existentes (bootstrap da migration 0014 rodou antes de
-- wms_worker precisar escrever aqui) — grant retroativo, idempotente.
DO $$
DECLARE
  v_partition RECORD;
BEGIN
  FOR v_partition IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'wms.stock_movement'::regclass
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON wms.%I TO wms_worker', v_partition.relname);
  END LOOP;
END
$$;

-- 2) partições FUTURAS (criadas por wms.ensure_stock_movement_partition,
-- chamada pelo PartitionManagerWorkerImpl) — grant automático dali em diante.
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
    -- RN-EST-014 (Entregável 4): ExpirationService (wms_worker) também
    -- escreve stock_movement via StockMovementService.apply() na mesma
    -- transação do worker.
    EXECUTE format('GRANT SELECT, INSERT ON wms.%I TO wms_worker', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (46, 'DOC-05 RF-EST-030/031: block_reason em stock_movement + wms.stock_reclassification (avaria/descarte) + fix stock_balance_unique NULLS NOT DISTINCT (RG-004) + grants wms_worker para RN-EST-014', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
