-- Migration: 0049
-- DOC-05 §4.2 — Sessão 5B: Seleção de Saldo e Reserva.
-- RN-EST-010 (universo de candidatos), RN-EST-011 (ordenação por política),
-- RN-EST-012 (shelf life mínimo), RN-EST-013 (quebra de política).

-- =============================================================================
-- 1. RN-EST-013 — anexo de autorização do cliente na exceção de quebra
-- "Exclusões por shelf life (RN-EST-012) admitem quebra apenas com
-- autorização registrada do cliente (ANEXO OBRIGATÓRIO na exceção)."
-- wms.operational_exception (DOC-12, migration 0020) não tem onde guardar
-- anexo. Coluna ADITIVA (default '{}'), no MESMO padrão já usado para prova
-- documental nesta base: wms.discrepancy.photo_keys (migration 0038) e
-- wms.stock_reclassification.photo_keys (migration 0046) — TEXT[] de chaves
-- de objeto no storage, sem FK.
-- Não altera nenhum comportamento existente: exceções que não exigem anexo
-- continuam com o array vazio, e nenhuma constraint nova incide sobre elas.
-- A obrigatoriedade do anexo é validada na app (StockReservationService), que
-- é quem conhece a distinção "quebra por ordem" × "quebra por shelf life" —
-- o banco não tem como saber o motivo da quebra a partir da linha da exceção.
-- =============================================================================
ALTER TABLE wms.operational_exception ADD COLUMN IF NOT EXISTS attachment_keys TEXT[] NOT NULL DEFAULT '{}';

-- =============================================================================
-- 2. wms.stock_reservation — DOC-00 §4.4 (glossário: `stock_reservation`,
-- "Vínculo de quantidade de saldo a um documento (pedido, transferência),
-- tornando-a indisponível para outras operações").
--
-- É o "detalhamento saldo→demanda persistido" exigido pelo entregável 6: UMA
-- LINHA POR ALOCAÇÃO (saldo × demanda), porque RN-EST-011 (§4.2, exemplo
-- normativo) atende uma demanda consumindo VÁRIOS saldos em ordem — o vínculo
-- é N:1 com a demanda, e o picking do DOC-06 vai consumir linha a linha.
--
-- [LACUNA: DOC-05 §7 (RD-EST-*) não modela a tabela de reserva — o §4.2 exige
-- o efeito ("efetivar a reserva") sem definir a estrutura. Modelagem desta
-- sessão, ancorada no glossário canônico do DOC-00 §4.4 e no mesmo padrão de
-- vínculo-a-documento já usado em wms.crossdock_link (migration 0040).]
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.stock_reservation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  -- Saldo de origem da reserva (a alocação). FK real: stock_balance tem PK
  -- simples (id), diferente de stock_movement (PK composta por ser particionada).
  stock_balance_id UUID NOT NULL REFERENCES wms.stock_balance(id) ON DELETE RESTRICT,
  -- Desnormalizados do saldo no INSTANTE da reserva: o saldo pode mudar de
  -- composição depois, e a auditoria (RG-003) precisa do que foi reservado.
  product_id UUID NOT NULL REFERENCES wms.product(id) ON DELETE RESTRICT,
  batch_id UUID REFERENCES wms.batch(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES wms.location(id) ON DELETE RESTRICT,
  pallet_id UUID REFERENCES wms.pallet(id) ON DELETE RESTRICT,
  qty NUMERIC(18,6) NOT NULL,
  -- Documento/demanda que originou a reserva. Sem FK: a demanda pode ser de
  -- módulos que ainda não existem (DOC-06 outbound_order, 5C inventory_count)
  -- — mesmo precedente de stock_movement.document_ref_id (migration 0014).
  demand_ref_type TEXT NOT NULL,
  demand_ref_id UUID NOT NULL,
  -- Finalidade (stock-selection.port.ts): decide se RN-EST-012 incidiu.
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  -- RN-EST-013 (RD-EST-005 espelha o mesmo par em stock_movement).
  policy_break BOOLEAN NOT NULL DEFAULT FALSE,
  break_reason TEXT,
  policy_break_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT,
  -- Movimentação RESERVA que efetivou esta linha. Sem FK (stock_movement é
  -- particionada, PK composta) — mesmo padrão de stock_reclassification.movement_id.
  movement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT stock_reservation_qty_check CHECK (qty > 0),
  CONSTRAINT stock_reservation_status_check CHECK (status IN ('ACTIVE', 'CONSUMED', 'CANCELLED')),
  CONSTRAINT stock_reservation_purpose_check CHECK (purpose IN ('CLIENT_DISPATCH', 'INTERNAL_REPLENISHMENT', 'INTERNAL_TRANSFER')),
  -- RN-EST-013: quebra de política SEMPRE carrega a exceção aprovada que a
  -- autorizou e o motivo — nunca uma quebra "solta".
  CONSTRAINT stock_reservation_policy_break_requires_exception CHECK (
    NOT policy_break OR (policy_break_exception_id IS NOT NULL AND break_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_stock_reservation_tenant ON wms.stock_reservation (tenant_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_reservation_demand ON wms.stock_reservation (demand_ref_type, demand_ref_id);
CREATE INDEX IF NOT EXISTS idx_stock_reservation_balance ON wms.stock_reservation (stock_balance_id);

ALTER TABLE wms.stock_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.stock_reservation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_reservation_tenant_isolation ON wms.stock_reservation;
CREATE POLICY stock_reservation_tenant_isolation ON wms.stock_reservation
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.stock_reservation TO wms_app;

-- =============================================================================
-- 3. RN-EST-011 — índice para a derivação da "data de entrada do saldo"
-- (primeiro stock_movement de ENTRADA do saldo, ver loadCandidates em
-- stock-selection.service.ts). A consulta filtra por endereço de destino +
-- produto e agrega MIN(occurred_at); sem índice, cada seleção varreria as
-- partições inteiras de stock_movement.
-- Índice no PAI particionado: o Postgres cria automaticamente o índice
-- correspondente em cada partição existente e futura (diferente de GRANT,
-- que não propaga — ver migration 0046).
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_stock_movement_entry_lookup
  ON wms.stock_movement (product_id, location_id_to, occurred_at)
  WHERE location_id_to IS NOT NULL AND balance_bucket_to IS NOT NULL;

-- =============================================================================
-- 4. Grants ADR-006/wms_worker — RF-EST-041 (kanban) passa a consumir a
-- Seleção de Saldo real, que lê zona (JIT/CROSS_DOCKING), equipamento
-- (RN-DAD-010/LIFO_PHYSICAL) e a política padrão do cliente×armazém (RG-006).
-- O job roda cross-tenant via transactionAsWorker (mesmo padrão das migrations
-- 0046/0047). Least privilege: apenas SELECT, apenas o que a seleção lê.
-- =============================================================================
GRANT SELECT ON wms.zone TO wms_worker;
GRANT SELECT ON wms.storage_equipment TO wms_worker;
GRANT SELECT ON wms.client_warehouse_settings TO wms_worker;

-- RG-015 na seleção (RN-EST-010 "respeitando contenção RG-015") tem DUAS
-- leituras, e o worker precisa das duas:
--  - item 2 (endereço de armazém lógico alheio nunca é candidato): função
--    SECURITY DEFINER da migration 0043, até aqui executável só por wms_app;
--  - item 1 (cliente COM armazém lógico ativo só usa endereços dele): leitura
--    direta de wms.logical_warehouse, que nunca havia sido concedida ao
--    worker. Sem ela o kanban falha com "permission denied" ao selecionar.
GRANT EXECUTE ON FUNCTION wms.logical_warehouse_location_owners(UUID[]) TO wms_worker;
GRANT SELECT ON wms.logical_warehouse TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (49, 'DOC-05 RN-EST-010/011/012/013: wms.stock_reservation + attachment_keys em operational_exception + indice de data de entrada + grants wms_worker para selecao', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
