-- Migration: 0067
-- DOC-15 COL-1 — MyTasksService.listMyTasks() roda cross-tenant
-- (transactionAsWorker, RN-SEG-011: um operador de campo pode ter tarefas
-- atribuídas de vários clientes no mesmo armazém, mesmo raciocínio de
-- OperationsBoardService/DOC-10) e precisa exibir o LPN do palete de cada
-- tarefa de putaway (RF-REC-042: é o LPN que o operador lê no passo 1, não o
-- produto — palete pode ser misto). wms_worker nunca havia lido
-- wms.pallet. GRANT explícito por consumidor real, mesmo achado de sempre
-- (ver CLAUDE.md).

GRANT SELECT ON wms.pallet TO wms_worker;

-- SyncStatusService.getStatus() (T8) lê a fila por device_id — um
-- dispositivo não pertence a um único tenant (mesmo raciocínio de T1
-- acima), então a leitura é cross-tenant. wms.sync_operation existe desde a
-- migration 0006 mas nunca teve consumidor (worker: NONE) — primeiro
-- consumidor real desta sessão.
GRANT SELECT ON wms.sync_operation TO wms_worker;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (67, 'DOC-15: GRANT SELECT a wms_worker em wms.pallet (T1) e wms.sync_operation (T8)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
