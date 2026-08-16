-- Migration: 0010
-- Corrige o debito RN-DAD-003 identificado no relatorio da Sessao 2A
-- (docs/relatorios/SESSAO-2A-relatorio.md §4): a migration 0001, ja aplicada
-- e rastreada em wms.schema_migration, executa
-- "ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE, DELETE
-- ON TABLES TO wms_app" -- isso concede DELETE por padrao a TODAS as tabelas
-- futuras do schema, neutralizando os GRANTs restritivos (sem DELETE) das
-- migrations de negocio 0008/0009 e enfraquecendo RN-DAD-003 ("E PROIBIDO
-- DELETE fisico em entidades referenciadas por movimentacoes"). A migration
-- 0001 nao pode ser editada (ja aplicada) -- corrigido aqui, em migration nova.

-- 1. Dali pra frente, tabelas NOVAS do schema wms NAO recebem DELETE por
--    padrao. Cada migration de negocio deve conceder DELETE explicitamente
--    apenas onde RN-DAD-003 permite (vinculos N:N de configuracao, rascunhos
--    nunca efetivados, tabelas tecnicas com retencao).
ALTER DEFAULT PRIVILEGES IN SCHEMA wms REVOKE DELETE ON TABLES FROM wms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT, INSERT, UPDATE ON TABLES TO wms_app;

-- 2. Revoga DELETE das tabelas de negocio JA CRIADAS (0008/0009) que
--    herdaram o privilegio pelo default ACL da migration 0001 -- sao
--    exatamente as "entidades referenciadas por movimentacoes" listadas em
--    RN-DAD-004 (GLOBAIS de §5.2 + DE TENANT de §5.1, exceto o vinculo N:N).
--    NAO inclui wms.logical_warehouse_location: RN-DAD-003 permite DELETE
--    fisico em "vinculos N:N de configuracao" -- e exatamente o que essa
--    tabela e, e logical-warehouse.service.ts#unlink() depende disso (ja
--    tem GRANT DELETE explicito desde a migration 0009).
REVOKE DELETE ON wms.warehouse FROM wms_app;
REVOKE DELETE ON wms.zone FROM wms_app;
REVOKE DELETE ON wms.storage_equipment FROM wms_app;
REVOKE DELETE ON wms.location FROM wms_app;
REVOKE DELETE ON wms.dock FROM wms_app;
REVOKE DELETE ON wms.yard_slot FROM wms_app;
REVOKE DELETE ON wms.client FROM wms_app;
REVOKE DELETE ON wms.client_warehouse_settings FROM wms_app;
REVOKE DELETE ON wms.logical_warehouse FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (10, 'Fix RN-DAD-003: remove default DELETE privilege from wms_app, revoke on existing business tables', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
