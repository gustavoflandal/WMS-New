-- Migration: 0053
-- Bugfix estrutural (achado 3x, mesma forma, nas Sessoes 5A/5B/5C — ver
-- docs/relatorios/SESSAO-5C-relatorio.md §5.2/§5.3): a policy
-- app_parameter_visibility (migration 0004) exigia app.tenant_ids
-- configurado MESMO para linhas scope='GLOBAL', apesar de DOC-02 §5.7
-- definir GLOBAL como o escopo com scope_id NULL — não ligado a tenant
-- algum, portanto sem motivo para depender de contexto de sessão.
--
-- Efeito prático do bug: toda leitura/escrita de parâmetro GLOBAL feita sem
-- contexto de tenant (DatabaseService.queryGlobal(), a via correta e
-- documentada para tabela sem RLS — mas app_parameter TEM RLS mesmo para
-- linhas GLOBAL) batia 0 linhas / falhava o WITH CHECK em silêncio, mascarada
-- pelo fallback para default de cada chamador. Corrigido aqui NA POLICY —
-- não nos chamadores — para que queryGlobal() volte a ser seguro para
-- app_parameter GLOBAL como já era para as demais tabelas GLOBAL
-- (warehouse, zone, location, ...). Linhas WAREHOUSE/CLIENT/CLIENT_WAREHOUSE
-- continuam exigindo contexto de tenant, sem mudança de comportamento.

DROP POLICY IF EXISTS app_parameter_visibility ON wms.app_parameter;

CREATE POLICY app_parameter_visibility ON wms.app_parameter
  FOR ALL
  USING (
    scope = 'GLOBAL'
    OR (
      NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
      AND (
        (scope = 'WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID)
        OR (scope = 'CLIENT'
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
        OR (scope = 'CLIENT_WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
      )
    )
  )
  WITH CHECK (
    scope = 'GLOBAL'
    OR (
      NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
      AND (
        (scope = 'WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID)
        OR (scope = 'CLIENT'
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
        OR (scope = 'CLIENT_WAREHOUSE'
          AND warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
          AND client_id = NULLIF(current_setting('app.client_id', true), '')::UUID)
      )
    )
  );

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (53, 'app_parameter_visibility: escopo GLOBAL legivel/gravavel sem contexto de tenant (DOC-02 5.7)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
