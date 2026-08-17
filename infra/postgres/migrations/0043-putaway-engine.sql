-- Migration: 0043
-- DOC-04 §4.5 (Motor de Putaway, AD-006) — suporte de dados para
-- RN-REC-040 (2 fases), RN-REC-041 (override) e RF-REC-042 (execução).
-- A tabela wms.putaway_task em si já existe desde a migration 0039
-- (Sessão 4A, ESTRUTURA apenas); aqui entram as colunas que só a execução
-- real exige, o parâmetro de ranqueamento, a permissão de execução e a
-- função de leitura cross-tenant exigida por RG-015.

-- =============================================================================
-- 1. Permissão de EXECUÇÃO de tarefa de putaway
-- [LACUNA: DOC-04 §3 nomeia `OPERADOR_EMPILHADEIRA` com a interação
-- "Execução de tarefas de putaway", mas o catálogo de 6 permissões REC.* do
-- §3 NÃO tem um código para essa ação, e o catálogo EST.* (DOC-12, migration
-- 0016) só cobre override/quebra-de-giro/transbordo/vínculo/digitação-LPN.
-- Mesma classe de omissão já tratada na Sessão 4 com POR.FILA_CONSULTAR
-- (RF-POR-020 descrevia a funcionalidade sem enumerar seu código): permissão
-- criada citando a fonte exata (RF-REC-042 + tabela de atores §3), não
-- inventada livremente. RN-SEG-012 exige que TODA rota declare permissão —
-- sem este código as rotas de execução não teriam o que declarar.]
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('REC.EXECUTAR_PUTAWAY', 'CLIENT_WAREHOUSE', 'Execucao de tarefa de putaway: sugestao, atribuicao e dupla leitura (DOC-04 RF-REC-042)', FALSE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- OPERADOR_EMPILHADEIRA: "Execução de tarefas de putaway" (§3, literal).
-- LIDER_TURNO: §3 lhe atribui "designação de conferentes, decisão de
-- exceções" — a atribuição de tarefa a operador é a mesma categoria de ação
-- de coordenação, e RF-REC-042 fala em "Tarefa atribuível" sem nomear quem
-- atribui. GESTOR_ARMAZEM acompanha por já deter EST.PUTAWAY_OVERRIDE.
INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, 'REC.EXECUTAR_PUTAWAY', '00000000-0000-0000-0000-000000000001'
FROM wms.role r
WHERE r.code IN ('OPERADOR_EMPILHADEIRA', 'LIDER_TURNO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 2. Colunas de execução em wms.putaway_task (RF-REC-042, §5.2)
-- =============================================================================
-- RF-REC-042: "fila por prioridade e proximidade". Prioridade menor = mais
-- urgente (mesma convenção de ordenação ascendente usada em toda a base).
-- [LACUNA: DOC-04 não define a escala nem a origem do valor de prioridade —
-- default neutro 100, ajustável por quem gera/atribui a tarefa.]
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100;
-- Endereço REALMENTE lido/confirmado na execução: igual a
-- location_id_designated no caminho normal; diferente apenas quando houve
-- override aprovado (RN-REC-041).
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS location_id_executed UUID REFERENCES wms.location(id) ON DELETE RESTRICT;
-- RN-REC-041: "a escolha exige motivo e gera auditoria OVERRIDE".
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS override_reason TEXT;
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
-- RF-REC-051 (fecha o [DÉBITO: 4B] da Sessão 4A): tarefa de putaway gerada
-- porque o Pedido vinculado ao cross-docking foi cancelado.
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS crossdock_link_id UUID REFERENCES wms.crossdock_link(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_putaway_task_queue ON wms.putaway_task (warehouse_id, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_putaway_task_assigned ON wms.putaway_task (assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;

-- =============================================================================
-- 3. wms.putaway_operation — idempotência da confirmação (RNF-ARQ-050)
-- RF-REC-042: "Operação disponível offline". O coletor (DOC-15, fora de
-- escopo) reenvia a mesma confirmação ao reconectar; o serviço precisa ser
-- idempotente por `operation_id` gerado no dispositivo. Tabela PRÓPRIA (não
-- uma coluna em putaway_task) porque putaway_task é PARTICIONADA por
-- created_at — um índice UNIQUE nela teria que incluir a chave de partição,
-- o que não daria unicidade GLOBAL do operation_id, que é justamente o que
-- a idempotência exige.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.putaway_operation (
  operation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  putaway_task_id UUID NOT NULL,
  -- Resposta original devolvida ao chamador, reenviada tal e qual em toda
  -- repetição da mesma operation_id (idempotência observável, não só "não
  -- duplica efeito colateral").
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_putaway_operation_task ON wms.putaway_operation (putaway_task_id);

ALTER TABLE wms.putaway_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.putaway_operation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS putaway_operation_tenant_isolation ON wms.putaway_operation;
CREATE POLICY putaway_operation_tenant_isolation ON wms.putaway_operation
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.putaway_operation TO wms_app;

-- =============================================================================
-- 4. REC.CRITERIOS_PUTAWAY (RN-REC-040 Fase 2)
-- Catálogo FECHADO de 6 critérios; a ORDEM é configurável por armazém.
-- [LACUNA: DOC-04 §4.5 não define a ordem PADRÃO do parâmetro — apresenta o
-- catálogo e UM exemplo normativo. Semeada aqui a ordem desse exemplo
-- ([ZONA_PREFERENCIAL_PRODUTO, CLASSE_ABC, MENOR_NIVEL]), única ordenação
-- concreta que o documento enuncia; qualquer armazém pode sobrescrever com
-- uma linha WAREHOUSE própria (precedência de app_parameter, DOC-01 §6).]
-- =============================================================================
-- NOT EXISTS em vez de ON CONFLICT DO NOTHING: wms.app_parameter (migration
-- 0004) não tem constraint UNIQUE em (scope, name), então ON CONFLICT sem
-- alvo NUNCA dispara e uma reexecução duplicaria a linha silenciosamente
-- (verificado rodando esta migration 3x contra o banco de teste).
INSERT INTO wms.app_parameter (scope, name, value)
SELECT 'GLOBAL', 'REC.CRITERIOS_PUTAWAY', '["ZONA_PREFERENCIAL_PRODUTO","CLASSE_ABC","MENOR_NIVEL"]'
WHERE NOT EXISTS (
  SELECT 1 FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'REC.CRITERIOS_PUTAWAY'
);

-- =============================================================================
-- 5. RG-015 [INVIOLÁVEL] — leitura CROSS-TENANT de vínculo de Armazém Lógico
-- RG-015 item 2: "QUANDO qualquer operação tentar movimentar produto de
-- OUTRO cliente para endereço vinculado a um Armazém Lógico, o sistema DEVE
-- rejeitar a operação". Para CUMPRIR isso, o motor (rodando no contexto do
-- cliente A) precisa saber que um endereço pertence ao armazém lógico do
-- cliente B — informação que a RLS de wms.logical_warehouse_location
-- esconde justamente de A. Sem esta função, o filtro 2 seria um no-op
-- silencioso: A não veria o vínculo de B e sugeriria o endereço.
-- SECURITY DEFINER (mesmo padrão de wms.ensure_stock_movement_partition,
-- migration 0014) com search_path fixo. Expõe SOMENTE o par
-- (endereço -> tenant dono), o mínimo necessário para a regra — nenhum dado
-- de negócio do outro cliente.
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.logical_warehouse_location_owners(p_location_ids UUID[])
RETURNS TABLE (location_id UUID, owner_tenant_id UUID, logical_warehouse_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wms, pg_temp
AS $$
  SELECT lwl.location_id, lw.tenant_id, lw.id
  FROM wms.logical_warehouse_location lwl
  JOIN wms.logical_warehouse lw ON lw.id = lwl.logical_warehouse_id
  WHERE lwl.location_id = ANY(p_location_ids)
    AND lw.status = 'ACTIVE';
$$;

REVOKE ALL ON FUNCTION wms.logical_warehouse_location_owners(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms.logical_warehouse_location_owners(UUID[]) TO wms_app;

-- =============================================================================
-- 6. Ocupação FÍSICA do endereço — leitura cross-tenant (filtros 3 e 5)
-- AD-001: "armazém compartilhado entre clientes". Um endereço físico pode,
-- portanto, conter saldo de MAIS DE UM cliente — e duas regras [INVIOLÁVEL]
-- dependem de enxergar TUDO que está lá, não só o do próprio tenant:
--   * RN-EST-022 (DOC-05 §4.3): "Um mesmo endereço PODE conter múltiplos
--     produtos SOMENTE quando TODAS as espécies presentes pertencerem à
--     MESMA classe de segregação". Calculado só com o saldo do próprio
--     tenant, o motor deixaria FARMA do cliente A entrar em endereço que já
--     tem INFLAMAVEIS do cliente B — exatamente a "mercadoria em local
--     ilegal" que RG-005 proíbe.
--   * RN-REC-040 filtro 5: capacidade "considerando o saldo/ocupação
--     ATUAL" — a capacidade física do endereço é uma só, independente de
--     quantos clientes a estão consumindo.
-- Expõe SOMENTE agregados físicos (peso, volume, contagem de paletes) +
-- classes de segregação + ids de lote (necessários ao filtro 6). NÃO expõe
-- produto, quantidade por produto nem qualquer identificação comercial de
-- outro cliente.
-- Paletes contados das DUAS origens: stock_balance (putaway normal) e
-- pallet.current_location_id (palete de cross-docking, que ocupa endereço
-- sem gerar stock_balance nesta fase do sistema — ver LACUNA DOC-05 na
-- Sessão 4A).
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.location_physical_occupancy(p_warehouse_id UUID)
RETURNS TABLE (
  location_id UUID,
  total_weight_kg NUMERIC,
  total_volume_m3 NUMERIC,
  distinct_pallets INT,
  segregation_classes TEXT[],
  batch_ids UUID[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wms, pg_temp
AS $$
  WITH balance AS (
    SELECT sb.location_id,
           SUM(
             (sb.qty_available + sb.qty_reserved + sb.qty_blocked + sb.qty_quarantine + sb.qty_damaged + sb.qty_in_transit)
             * COALESCE(p.gross_weight_kg, 0)
           ) AS weight_kg,
           SUM(
             (sb.qty_available + sb.qty_reserved + sb.qty_blocked + sb.qty_quarantine + sb.qty_damaged + sb.qty_in_transit)
             * COALESCE(p.length_m, 0) * COALESCE(p.width_m, 0) * COALESCE(p.height_m, 0)
           ) AS volume_m3,
           array_agg(DISTINCT ps.segregation_class) FILTER (WHERE ps.segregation_class IS NOT NULL) AS classes,
           array_agg(DISTINCT sb.batch_id) FILTER (WHERE sb.batch_id IS NOT NULL) AS batches
    FROM wms.stock_balance sb
    JOIN wms.product p ON p.id = sb.product_id
    JOIN wms.product_species ps ON ps.code = p.species_code
    WHERE sb.warehouse_id = p_warehouse_id
    GROUP BY sb.location_id
  ),
  pallets AS (
    SELECT loc AS location_id, COUNT(DISTINCT pallet_id)::INT AS n
    FROM (
      SELECT sb.location_id AS loc, sb.pallet_id
      FROM wms.stock_balance sb
      WHERE sb.warehouse_id = p_warehouse_id AND sb.pallet_id IS NOT NULL
      UNION
      SELECT pl.current_location_id AS loc, pl.id AS pallet_id
      FROM wms.pallet pl
      WHERE pl.current_location_id IS NOT NULL
    ) src
    GROUP BY loc
  )
  SELECT l.id,
         COALESCE(b.weight_kg, 0),
         COALESCE(b.volume_m3, 0),
         COALESCE(pt.n, 0),
         COALESCE(b.classes, ARRAY[]::TEXT[]),
         COALESCE(b.batches, ARRAY[]::UUID[])
  FROM wms.location l
  LEFT JOIN balance b ON b.location_id = l.id
  LEFT JOIN pallets pt ON pt.location_id = l.id
  WHERE l.warehouse_id = p_warehouse_id;
$$;

REVOKE ALL ON FUNCTION wms.location_physical_occupancy(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms.location_physical_occupancy(UUID) TO wms_app;

-- =============================================================================
-- 7. product_species.segregation_class — valores REAIS (DOC-05 RN-EST-020)
-- Fecha um débito explícito da migration 0011 (Sessão 2B), que semeou
-- `segregation_class` com o PRÓPRIO código da espécie e registrou:
-- "[LACUNA: DOC-02 nao define os valores de segregation_class (a matriz de
-- compatibilidade e do DOC-05/LAC-003, fora do escopo desta sessao) --
-- usando o proprio `code` como segregation_class provisorio ... ate o
-- DOC-05 definir a matriz real."
-- DOC-05 §4.3 RN-EST-020 define as 5 classes; sem esta atualização o filtro
-- 3 (RN-REC-040) compararia contra classes que não existem na matriz
-- RN-EST-021 e nunca reprovaria nada — o filtro seria um no-op silencioso.
-- =============================================================================
UPDATE wms.product_species SET segregation_class = 'FARMA',       updated_at = now() WHERE code = 'MEDICAMENTO'        AND segregation_class IS DISTINCT FROM 'FARMA';
UPDATE wms.product_species SET segregation_class = 'ALIMENTAR',   updated_at = now() WHERE code IN ('ALIMENTO', 'REFRIGERADO', 'CONGELADO') AND segregation_class IS DISTINCT FROM 'ALIMENTAR';
UPDATE wms.product_species SET segregation_class = 'INFLAMAVEIS', updated_at = now() WHERE code IN ('INFLAMAVEL', 'COMBUSTIVEL')           AND segregation_class IS DISTINCT FROM 'INFLAMAVEIS';
UPDATE wms.product_species SET segregation_class = 'QUIMICA',     updated_at = now() WHERE code = 'QUIMICO_CONTROLADO' AND segregation_class IS DISTINCT FROM 'QUIMICA';
UPDATE wms.product_species SET segregation_class = 'NEUTRA',      updated_at = now() WHERE code IN ('GERAL', 'FRAGIL', 'VALIOSO')          AND segregation_class IS DISTINCT FROM 'NEUTRA';

-- As 5 classes de RN-EST-020 são lista fechada — travada por CHECK para que
-- uma espécie futura não entre com classe fora da matriz RN-EST-021.
ALTER TABLE wms.product_species DROP CONSTRAINT IF EXISTS product_species_segregation_class_check;
ALTER TABLE wms.product_species ADD CONSTRAINT product_species_segregation_class_check
  CHECK (segregation_class IN ('FARMA', 'ALIMENTAR', 'INFLAMAVEIS', 'QUIMICA', 'NEUTRA'));

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (43, 'DOC-04 Sec 4.5: motor de putaway - REC.EXECUTAR_PUTAWAY, colunas de execucao em putaway_task, putaway_operation (idempotencia RNF-ARQ-050), REC.CRITERIOS_PUTAWAY, leituras cross-tenant RG-015/RN-EST-022, segregation_class real (RN-EST-020)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
