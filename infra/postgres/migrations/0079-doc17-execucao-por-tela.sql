-- Migration: 0079
-- DOC-17 §6 — Sessão 10E: Execução por Tela (backend).
-- RD-TEL-004 (`execution_channel` em tarefas e movimentações), RN-TEL-010
-- (parâmetro TEL.MODO_EXECUCAO), RN-TEL-012 item 4 (permissão própria
-- TEL.EXECUCAO_TELA) e TEL.MODO_EXECUCAO_CONFIGURAR (§4).
--
-- Fecha o catálogo TEL.* do DOC-17 §4: das 8 permissões declaradas lá, 3
-- entraram na 0073/0075 (DETALHE_CONSULTAR, FORMULARIO_*), 2 na 0078
-- (TRANSCREVER*), e as 2 últimas entram aqui.

-- ── 1. RD-TEL-004 — execution_channel em TAREFAS ──────────────────────────
-- "COLETOR | TELA | FORMULARIO, para auditoria e comparação de acuracidade".
-- Default COLETOR preserva a leitura correta do histórico: tudo que já
-- existe nasceu do coletor (DOC-15), único canal que havia.
DO $$
DECLARE
  t TEXT;
  v_tables TEXT[] := ARRAY['putaway_task', 'picking_task', 'replenishment_task', 'checking', 'package', 'loading', 'inventory_count_round'];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'wms' AND c.relname = t) THEN
      EXECUTE format('ALTER TABLE wms.%I ADD COLUMN IF NOT EXISTS execution_channel TEXT NOT NULL DEFAULT ''COLETOR''', t);
      EXECUTE format('ALTER TABLE wms.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_execution_channel_check');
      EXECUTE format(
        'ALTER TABLE wms.%I ADD CONSTRAINT %I CHECK (execution_channel IN (''COLETOR'', ''TELA'', ''FORMULARIO''))',
        t, t || '_execution_channel_check'
      );
    END IF;
  END LOOP;
END;
$$;

-- ── 2. RD-TEL-004 — execution_channel em MOVIMENTAÇÕES ────────────────────
-- wms.stock_movement é PARTICIONADA: ALTER no pai propaga a coluna às
-- partições existentes e futuras. É append-only (UPDATE revogado, migration
-- 0014), então o valor gravado no INSERT é definitivo — exatamente o que se
-- quer de um dado de auditoria.
ALTER TABLE wms.stock_movement ADD COLUMN IF NOT EXISTS execution_channel TEXT NOT NULL DEFAULT 'COLETOR';
ALTER TABLE wms.stock_movement DROP CONSTRAINT IF EXISTS stock_movement_execution_channel_check;
ALTER TABLE wms.stock_movement ADD CONSTRAINT stock_movement_execution_channel_check
  CHECK (execution_channel IN ('COLETOR', 'TELA', 'FORMULARIO'));

COMMENT ON COLUMN wms.stock_movement.execution_channel IS
  'DOC-17 RD-TEL-004: canal que originou a movimentacao (COLETOR/TELA/FORMULARIO), para comparar acuracidade entre modos (indicador do §13).';

-- Índice para o indicador recomendado no DOC-17 §13 (comparar acuracidade e
-- taxa de divergência entre COLETOR e FORMULARIO).
CREATE INDEX IF NOT EXISTS idx_stock_movement_execution_channel ON wms.stock_movement (warehouse_id, execution_channel, occurred_at);

-- ── 3. RN-TEL-010 — permissões (§4) ───────────────────────────────────────
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('TEL.EXECUCAO_TELA',              'CLIENT_WAREHOUSE', 'Executar operacao por tela, sem coletor (DOC-17 RN-TEL-012 item 4)', FALSE, '00000000-0000-0000-0000-000000000001'),
  ('TEL.MODO_EXECUCAO_CONFIGURAR',   'WAREHOUSE',        'Definir o Modo de Execucao do armazem (DOC-17 RN-TEL-010, sensivel)', TRUE,  '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- RN-TEL-012 item 4: "permissão própria, concedida DELIBERADAMENTE". Por
-- isso NÃO vai para todos os papéis operacionais por padrão — só para quem
-- opera sem coletor por decisão de implantação. Conservadoramente,
-- LIDER_TURNO e GESTOR_ARMAZEM; ampliar é ato explícito do cliente.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'TEL.EXECUCAO_TELA', '00000000-0000-0000-0000-000000000001'
FROM wms.role r WHERE r.code IN ('GESTOR_ARMAZEM', 'LIDER_TURNO')
ON CONFLICT DO NOTHING;

-- Configurar o modo do armazém é do Gestor (mesmo nível de PER.GESTAO_DISPOSITIVOS).
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'TEL.MODO_EXECUCAO_CONFIGURAR', '00000000-0000-0000-0000-000000000001'
FROM wms.role r WHERE r.code = 'GESTOR_ARMAZEM'
ON CONFLICT DO NOTHING;

-- ── 3.1 Correção de raiz: wms.app_parameter sem chave única ───────────────
-- Achado ao implementar o setMode desta sessão: `app_parameter` nunca teve
-- UNIQUE sobre (scope, name, warehouse_id, client_id) — que É a sua chave de
-- resolução (DOC-01 §6 / DOC-02 §5.7). Consequências reais:
--   · os `INSERT ... ON CONFLICT DO NOTHING` de 14 migrations não protegem
--     coisa alguma — sem constraint não há conflito a detectar, e uma
--     reexecução INSERE DUPLICATA em silêncio;
--   · com linha duplicada, a resolução de parâmetro (`ORDER BY scope LIMIT 1`)
--     passa a devolver uma das duas arbitrariamente — parâmetro de negócio
--     decidido por sorte.
--
-- Dedup antes de criar o índice (mantém a linha mais recente de cada chave),
-- para a migration não falhar em base que já tenha duplicata.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY scope, name, warehouse_id, client_id
    ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, id DESC
  ) AS rn
  FROM wms.app_parameter
)
DELETE FROM wms.app_parameter WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- NULLS NOT DISTINCT (PostgreSQL ≥ 15; DOC-00 §2.2 exige ≥ 16): sem isso,
-- linhas GLOBAL (warehouse_id e client_id nulos) escapariam da unicidade,
-- que é justamente o caso mais comum da tabela.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_parameter_scope_name_target
  ON wms.app_parameter (scope, name, warehouse_id, client_id) NULLS NOT DISTINCT;

-- ── 4. RN-TEL-010 — parâmetro do Modo de Execução ─────────────────────────
-- "COLETOR (apenas dispositivos), TELA (apenas telas e formulários),
-- HIBRIDO (ambos, à escolha do operador)". Padrão COLETOR: é o modo que o
-- sistema já operava (DOC-15), então a instalação existente não muda de
-- comportamento ao aplicar esta migration.
INSERT INTO wms.app_parameter (scope, name, value) VALUES
  ('GLOBAL', 'TEL.MODO_EXECUCAO', 'COLETOR')
ON CONFLICT DO NOTHING;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (79, 'DOC-17 10E: Execucao por Tela - execution_channel (RD-TEL-004) em tarefas e stock_movement, TEL.EXECUCAO_TELA, TEL.MODO_EXECUCAO_CONFIGURAR, parametro TEL.MODO_EXECUCAO', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
