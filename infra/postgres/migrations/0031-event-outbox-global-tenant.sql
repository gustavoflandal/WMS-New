-- Migration: 0031
-- DOC-03 §4.6/RF-POR-031 — wms.event_outbox.tenant_id passa a aceitar NULL
-- para eventos de domínio verdadeiramente GLOBAIS (sem client associável),
-- como portaria.pessoa_entrou/portaria.pessoa_saiu (RD-POR-004: person_visit
-- e visitor são GLOBAL, sem tenant_id — um visitante não pertence a nenhum
-- client específico). Até esta migration o schema exigia tenant_id NOT NULL,
-- o que impedia esses dois eventos catalogados em DOC-03 §4.6 de serem
-- publicados (débito registrado na Sessão 4, corrigido nesta mesma sessão
-- após revisão explícita do usuário — RF-POR-031 exige atualização em tempo
-- real do painel de presentes).

ALTER TABLE wms.event_outbox ALTER COLUMN tenant_id DROP NOT NULL;

DROP POLICY IF EXISTS event_outbox_tenant_isolation ON wms.event_outbox;

-- Linhas com tenant_id NULL são eventos GLOBAIS (não pertencem a nenhum
-- client) — visíveis/inseríveis independentemente do contexto de tenant da
-- sessão (queryGlobal/transactionGlobal não define app.tenant_ids). Linhas
-- com tenant_id preenchido continuam isoladas por tenant exatamente como
-- antes desta migration.
CREATE POLICY event_outbox_tenant_isolation ON wms.event_outbox
  FOR ALL
  USING (
    tenant_id IS NULL
    OR (
      NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
      AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
    )
  )
  WITH CHECK (
    tenant_id IS NULL
    OR (
      NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
      AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
    )
  );

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (31, 'DOC-03 RF-POR-031: event_outbox.tenant_id nullable para eventos GLOBAIS (portaria.pessoa_entrou/saiu)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
