-- Migration: 0056
-- Bugfix, mesma forma do achado que motivou o CLAUDE.md desta sessão (ver
-- migration 0053 para o caso original em app_parameter): as 5 policies
-- criadas na migration 0055 (kpi_daily, alert, alert_read, chat_room,
-- chat_message) exigiam `app.tenant_ids` configurado mesmo para linhas
-- `client_id`/`tenant_id` NULL — que, por desenho da própria 0055, são
-- exatamente as linhas "sem dimensão de cliente" (K-13 ocupação, Edge Agent
-- offline, sala armazém-turno, ...). O efeito é o MESMO bug de RLS
-- silenciosa: queryGlobal()/qualquer sessão sem contexto de tenant nunca via
-- essas linhas, mesmo tendo o warehouse_id certo. Corrigido na origem (a
-- policy), não nos chamadores — mesma disciplina de CLAUDE.md.
--
-- Regra corrigida: linha SEM dimensão de cliente (client_id/tenant_id NULL)
-- exige só `app.warehouse_id` (visível a qualquer sessão daquele armazém,
-- sem checar cliente). Linha COM dimensão de cliente continua exigindo
-- `app.tenant_ids` E `app.warehouse_id`, sem mudança.

DROP POLICY IF EXISTS kpi_daily_visibility ON wms.kpi_daily;
CREATE POLICY kpi_daily_visibility ON wms.kpi_daily
  FOR ALL
  USING (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      client_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND client_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  )
  WITH CHECK (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      client_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND client_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  );

DROP POLICY IF EXISTS alert_visibility ON wms.alert;
CREATE POLICY alert_visibility ON wms.alert
  FOR ALL
  USING (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  )
  WITH CHECK (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  );

DROP POLICY IF EXISTS alert_read_visibility ON wms.alert_read;
CREATE POLICY alert_read_visibility ON wms.alert_read
  FOR ALL
  USING (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  )
  WITH CHECK (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  );

DROP POLICY IF EXISTS chat_room_visibility ON wms.chat_room;
CREATE POLICY chat_room_visibility ON wms.chat_room
  FOR ALL
  USING (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  )
  WITH CHECK (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  );

DROP POLICY IF EXISTS chat_message_visibility ON wms.chat_message;
CREATE POLICY chat_message_visibility ON wms.chat_message
  FOR ALL
  USING (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  )
  WITH CHECK (
    warehouse_id = NULLIF(current_setting('app.warehouse_id', true), '')::UUID
    AND (
      tenant_id IS NULL
      OR (NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID)
    )
  );

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (56, 'DOC-10: kpi_daily/alert/alert_read/chat_room/chat_message - linhas sem cliente visiveis so com warehouse_id, sem exigir tenant_ids', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
