-- Migration: 0045
-- DOC-05 §4.1 RN-EST-001 [INVIOLÁVEL] — catálogo fechado de movement_type
-- (18 códigos distintos nas 14 linhas da tabela §4.1) + "nenhum módulo
-- escreve saldo diretamente" implementado POR CONSTRUÇÃO (trigger de guarda
-- em wms.stock_balance, análogo em espírito ao REVOKE UPDATE/DELETE já
-- usado em wms.stock_movement desde a migration 0014, mas aqui a operação
-- proibida é a PRÓPRIA escrita, não uma alteração posterior — por isso o
-- mecanismo é um trigger condicionado a uma session var, não um REVOKE puro:
-- INSERT/UPDATE precisam continuar possíveis, só que exclusivamente através
-- do StockMovementService). RD-EST-005: policy_break/break_reason em
-- stock_movement (RN-EST-013, fora do escopo funcional desta sessão, mas a
-- coluna é requisito de dados desta mesma sessão).

-- =============================================================================
-- 1. RN-EST-001 — catálogo fechado de wms.stock_movement.movement_type
-- Migration 0014 deixou a coluna sem CHECK, com [LACUNA] explícita apontando
-- para este documento. 18 códigos distintos (algumas linhas da tabela §4.1
-- juntam 2 códigos, ex. "RESERVA / LIBERACAO_RESERVA" — contados
-- individualmente aqui, não como uma única linha).
-- =============================================================================
ALTER TABLE wms.stock_movement DROP CONSTRAINT IF EXISTS stock_movement_type_check;
ALTER TABLE wms.stock_movement ADD CONSTRAINT stock_movement_type_check CHECK (movement_type IN (
  'ENTRADA_RECEBIMENTO',
  'PUTAWAY',
  'RESERVA',
  'LIBERACAO_RESERVA',
  'PICKING',
  'TRANSFERENCIA_INTERNA',
  'TRANSFERENCIA_SAIDA_ARMAZEM',
  'TRANSFERENCIA_ENTRADA_ARMAZEM',
  'REPOSICAO',
  'BLOQUEIO',
  'DESBLOQUEIO',
  'LIBERACAO_QUARENTENA',
  'RECLASSIFICACAO_AVARIA',
  'AJUSTE_INVENTARIO_POS',
  'AJUSTE_INVENTARIO_NEG',
  'DESCARTE',
  'ENTRADA_REVERSA',
  'SAIDA_EXPEDICAO'
));

-- =============================================================================
-- 2. RD-EST-005 — colunas adicionais em stock_movement (RN-EST-013)
-- =============================================================================
ALTER TABLE wms.stock_movement ADD COLUMN IF NOT EXISTS policy_break BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wms.stock_movement ADD COLUMN IF NOT EXISTS break_reason TEXT;

-- =============================================================================
-- 3. RN-EST-001 — "nenhum módulo escreve saldo diretamente", por construção.
-- StockMovementService é o ÚNICO chamador autorizado: a cada transação que
-- vai alterar stock_balance ele executa
--   SELECT set_config('app.stock_movement_authorized', 'true', true)
-- (escopo LOCAL — expira sozinho no COMMIT/ROLLBACK, mesmo padrão já usado
-- para app.tenant_ids/app.user_id em DatabaseService). Qualquer INSERT/UPDATE
-- em stock_balance fora dessa transação (ou sem essa chamada) é rejeitado
-- ANTES de chegar aos CHECKs de negócio (RG-004 etc.), que continuam
-- existindo como última linha de defesa e permanecem alcançáveis por quem
-- estiver de fato autorizado.
-- ERRCODE 42501 (insufficient_privilege) — mesmo código já usado no REVOKE
-- de UPDATE/DELETE de stock_movement (migration 0014), por analogia de
-- categoria de erro ("operação de escrita sem privilégio para realizá-la").
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.guard_stock_balance_direct_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.stock_movement_authorized', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'RN-EST-001 [INVIOLAVEL]: wms.stock_balance so pode ser alterado via StockMovementService (nenhum modulo escreve saldo diretamente)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_balance_guard_direct_write ON wms.stock_balance;
CREATE TRIGGER stock_balance_guard_direct_write
  BEFORE INSERT OR UPDATE ON wms.stock_balance
  FOR EACH ROW EXECUTE FUNCTION wms.guard_stock_balance_direct_write();

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (45, 'DOC-05 RN-EST-001: catalogo fechado movement_type (CHECK) + guarda por construcao em stock_balance + RD-EST-005', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
