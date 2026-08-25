-- Migration: 0076
-- Correções de revisão do projeto (2026-08-25). Dois itens independentes:
--
-- 1. RG-015 item 3 [INVIOLÁVEL] — transbordo do Armazém Lógico. O tipo de
--    exceção EST.TRANSBORDO_ARMAZEM_LOGICO já existia (migration 0044) e a
--    permissão EST.LOGICAL_WAREHOUSE_OVERFLOW também (0016), mas NENHUM
--    código jamais abria a exceção: quando o Armazém Lógico do cliente
--    lotava, o putaway simplesmente reprovava todo endereço e a operação
--    ficava sem saída (palete parado, sem exceção para ninguém aprovar).
--    Estas colunas materializam a marca "TRANSBORDO" exigida pela regra.
--
-- 2. DOC-17 RN-TEL-012 item 3 exige `origin = PAPEL` para movimentação
--    originada de transcrição de Formulário de Campo. O CHECK de
--    audit_log.origin não admitia o valor — a sessão de Transcrição (§8)
--    bateria nisso. Alargado aqui, junto do enum canônico.

-- ── 1. RG-015 item 3 — marca de transbordo na tarefa de putaway ───────────
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS is_overflow BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wms.putaway_task ADD COLUMN IF NOT EXISTS overflow_exception_id UUID REFERENCES wms.operational_exception(id) ON DELETE RESTRICT;

COMMENT ON COLUMN wms.putaway_task.is_overflow IS
  'RG-015 item 3: alocacao temporaria FORA do Armazem Logico do cliente, autorizada por excecao EST.TRANSBORDO_ARMAZEM_LOGICO aprovada. Retorno obrigatorio quando houver capacidade.';

-- Coerência: só há transbordo com a exceção que o autorizou, e vice-versa.
-- Sem isso seria possível marcar TRANSBORDO sem autorização nenhuma —
-- exatamente o que a RG-015 item 3 proíbe.
ALTER TABLE wms.putaway_task DROP CONSTRAINT IF EXISTS putaway_task_overflow_requires_exception;
ALTER TABLE wms.putaway_task ADD CONSTRAINT putaway_task_overflow_requires_exception
  CHECK ((is_overflow = FALSE AND overflow_exception_id IS NULL) OR (is_overflow = TRUE AND overflow_exception_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_putaway_task_overflow ON wms.putaway_task (warehouse_id, tenant_id) WHERE is_overflow = TRUE;

-- ── 2. DOC-17 RN-TEL-012 item 3 — origem PAPEL ────────────────────────────
-- DOC-00 §4.8 (enums canônicos): valor novo entra por adição formal, e o
-- DOC-17 (APROVADO) já o exige nominalmente ("grava origin = WEB ou
-- SYNC/PAPEL conforme o caso").
ALTER TABLE wms.audit_log DROP CONSTRAINT IF EXISTS audit_log_origin_check;
ALTER TABLE wms.audit_log ADD CONSTRAINT audit_log_origin_check
  CHECK (origin IN ('WEB', 'PWA', 'PORTAL', 'API', 'EDGE', 'SCHEDULER', 'SYNC', 'PAPEL'));

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (76, 'Revisao: RG-015 item 3 (marca de transbordo em putaway_task) + origin PAPEL no audit_log (DOC-17 RN-TEL-012)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
