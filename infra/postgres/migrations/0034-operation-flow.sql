-- Migration: 0034
-- DOC-00 §4.5 (glossário: operation_flow/flow_step, termos canônicos
-- cross-módulo) + RG-002 [INVIOLÁVEL] (fluxo sequencial sem salto de
-- etapas). Primeira implementação real deste conceito genérico — usado por
-- DOC-04 RF-REC-020 nesta sessão, desenhado para ser reaproveitado por
-- outros módulos operacionais (DOC-06/07) quando existirem, sem overengineer:
-- só os campos exigidos por RG-002 + pela instanciação dinâmica de etapa
-- (RF-REC-020: "Divergências" intercalada dinamicamente).
--
-- sequence_order em incrementos de 100 (10, 20, 30...): permite inserir uma
-- etapa dinâmica ENTRE duas existentes (ex.: Divergências entre Conferência
-- e Etiquetagem) sem precisar renumerar as etapas já criadas.

CREATE TABLE IF NOT EXISTS wms.operation_flow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  entity TEXT NOT NULL,
  entity_id UUID NOT NULL,
  flow_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT operation_flow_entity_unique UNIQUE (entity, entity_id),
  CONSTRAINT operation_flow_status_check CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_operation_flow_entity ON wms.operation_flow (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_operation_flow_tenant ON wms.operation_flow (tenant_id);

ALTER TABLE wms.operation_flow ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.operation_flow FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operation_flow_tenant_isolation ON wms.operation_flow;
CREATE POLICY operation_flow_tenant_isolation ON wms.operation_flow
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.operation_flow TO wms_app;

CREATE TABLE IF NOT EXISTS wms.flow_step (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- tenant_id duplicado do operation_flow pai (mesmo padrão já usado em
  -- toda tabela-filha TENANT deste schema, ex. stock_balance/batch) —
  -- simplifica a policy RLS para comparação direta em vez de EXISTS/JOIN.
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  operation_flow_id UUID NOT NULL REFERENCES wms.operation_flow(id) ON DELETE RESTRICT,
  step_code TEXT NOT NULL,
  sequence_order INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT flow_step_code_unique UNIQUE (operation_flow_id, step_code),
  CONSTRAINT flow_step_order_unique UNIQUE (operation_flow_id, sequence_order),
  CONSTRAINT flow_step_status_check CHECK (status IN ('PENDING', 'DONE'))
);

CREATE INDEX IF NOT EXISTS idx_flow_step_flow ON wms.flow_step (operation_flow_id, sequence_order);

ALTER TABLE wms.flow_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.flow_step FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_step_tenant_isolation ON wms.flow_step;
CREATE POLICY flow_step_tenant_isolation ON wms.flow_step
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.flow_step TO wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (34, 'DOC-00/RG-002: operation_flow + flow_step (TENANT, RLS) - maquina de fluxo generica reutilizavel entre modulos', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
