-- Migration: 0058
-- DOC-10 RF-PAI-010 — AlertService.list()/countUnread() rodam via
-- transactionAsWorker (mesmo raciocínio de OperationsBoardService: contam/
-- listam alertas de vários clientes de uma vez) e fazem LEFT JOIN em
-- wms.alert_read para marcar o que o usuário já leu — wms_worker nunca
-- havia lido esta tabela (só tinha INSERT... não, nem isso: alert_read é
-- wms_app-only por design, mas a LEITURA cross-cliente do centro de
-- alertas precisa do SELECT do worker). GRANT explícito (ver CLAUDE.md).
GRANT SELECT ON wms.alert_read TO wms_worker;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (58, 'DOC-10: GRANT SELECT a wms_worker em alert_read para AlertService.list/countUnread', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
