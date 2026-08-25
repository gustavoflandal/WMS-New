-- Migration: 0074
-- DOC-17 10A — achado ao adicionar wms.return_order na UNION cross-tenant de
-- operations-board.service.ts (DOC-10 painel, roda como wms_worker/
-- transactionAsWorker): wms_worker nunca tinha recebido GRANT SELECT nessa
-- tabela (migration 0071 declarou wms_worker: NONE, correto até este
-- momento — nenhum job cross-tenant a lia). Mesmo padrão de achado já visto
-- 3x no projeto (grants-contract.integration.spec.ts existe exatamente para
-- isso): GRANT faltante só aparece quando um caminho de código real usa a
-- tabela por wms_worker.

GRANT SELECT ON wms.return_order TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (74, 'DOC-17 10A: GRANT SELECT em wms.return_order para wms_worker (operations-board cross-tenant, achado real)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
