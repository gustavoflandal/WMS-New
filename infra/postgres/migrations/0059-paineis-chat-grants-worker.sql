-- Migration: 0059
-- DOC-10 RF-PAI-030 — ChatService.getOrCreateWarehouseShiftRoom()/
-- getOrCreateOperationRoom()/sendMessage() rodam (a sala armazém-turno e o
-- envio) via transactionAsWorker: mesma sala é potencialmente acessada por
-- qualquer cliente do armazém (sala armazém-turno tem tenant_id NULL por
-- desenho), não faz sentido abrir sob o tenant de UM cliente específico.
-- wms_worker nunca havia tocado chat_room/chat_message. GRANT explícito
-- (SELECT+INSERT — mesmo padrão de wms_app; nenhuma UPDATE, mensagem
-- imutável).
GRANT SELECT, INSERT ON wms.chat_room TO wms_worker;
GRANT SELECT, INSERT ON wms.chat_message TO wms_worker;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (59, 'DOC-10: GRANT SELECT, INSERT a wms_worker em chat_room/chat_message para ChatService', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
