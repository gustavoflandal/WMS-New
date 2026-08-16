-- Migration: 0022
-- DOC-12 RN-SEG-042 — ExceptionExpiryWorkerImpl (scheduler) roda via
-- transactionAsWorker (ADR-006, BYPASSRLS) e precisa publicar um evento
-- (seguranca.excecao_rejeitada) para cada exceção expirada, via
-- EventsService.publishInTransaction() — um INSERT em wms.event_outbox.
-- A migration 0005 só concedeu SELECT/UPDATE a wms_worker (suficiente para
-- o outbox-publisher, que só LÊ e marca published_at); nenhum worker
-- anterior precisava INSERIR no outbox. wms.event_outbox não pode ser
-- editada (migration 0005 já aplicada) -- corrigido aqui, migration nova,
-- mesmo padrão da correção da migration 0010 (Sessão 2B).
GRANT INSERT ON wms.event_outbox TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (22, 'DOC-12 RN-SEG-042: grant INSERT on event_outbox to wms_worker (exception-expiry publishes events)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
