-- Migration: 0072
-- DOC-07 — Sessão 9B: integração real com Gate-in/Portaria (RN-REV-002,
-- RF-REV-001 RECUSA_ENTREGA) e Recall (RF-REV-030).

-- =============================================================================
-- 1. wms.vehicle_visit.blocking_reason — novo valor SEM_AUTORIZACAO_REVERSA
-- (RN-REV-002: gate-in de devolução sem Ordem autorizada "aguarda fora",
-- mesmo padrão de SEM_AGENDAMENTO).
-- =============================================================================
ALTER TABLE wms.vehicle_visit DROP CONSTRAINT IF EXISTS vehicle_visit_blocking_reason_check;
ALTER TABLE wms.vehicle_visit ADD CONSTRAINT vehicle_visit_blocking_reason_check CHECK (
  blocking_reason IS NULL OR blocking_reason IN ('SEM_AGENDAMENTO', 'FORA_DA_JANELA', 'SEM_VAGA_HAZMAT', 'SEM_VAGA_DISPONIVEL', 'SEM_AUTORIZACAO_REVERSA')
);

-- =============================================================================
-- 2. wms.return_order.type — RECUSA_ENTREGA (RF-REV-001, criação automática
-- no gate-in) e RECALL (RF-REV-030) entram no catálogo agora que têm
-- chamador real (mesmo padrão "tipo sem chamador não aparece" da 9A).
-- RECALL, como REVERSA_AVULSA, não tem uma única Ordem de origem (pode
-- agregar itens de vários pedidos que expediram o lote) — a exigência de
-- source_outbound_order_id passa a valer só para DEVOLUCAO_CLIENTE_FINAL/
-- AVARIA_TRANSPORTE/RECUSA_ENTREGA.
-- =============================================================================
ALTER TABLE wms.return_order DROP CONSTRAINT IF EXISTS return_order_type_check;
ALTER TABLE wms.return_order ADD CONSTRAINT return_order_type_check CHECK (
  type IN ('DEVOLUCAO_CLIENTE_FINAL', 'AVARIA_TRANSPORTE', 'REVERSA_AVULSA', 'RECUSA_ENTREGA', 'RECALL')
);

ALTER TABLE wms.return_order DROP CONSTRAINT IF EXISTS return_order_source_required_check;
ALTER TABLE wms.return_order ADD CONSTRAINT return_order_source_required_check CHECK (
  type IN ('REVERSA_AVULSA', 'RECALL') OR source_outbound_order_id IS NOT NULL
);

-- =============================================================================
-- 3. Permissão REV.RECALL — DOC-07 §3 (catálogo já citado na 9A, sem
-- chamador até agora).
-- =============================================================================
INSERT INTO wms.permission (code, scope, description, is_sensitive, created_by) VALUES
  ('REV.RECALL', 'CLIENT_WAREHOUSE', 'Acionamento de recall de lote (DOC-07 RF-REV-030)', TRUE, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

INSERT INTO wms.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '00000000-0000-0000-0000-000000000001'
FROM wms.role r CROSS JOIN (VALUES ('REV.RECALL')) AS p(code)
WHERE r.code IN ('CLIENTE_OPERACAO', 'GESTOR_ARMAZEM')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 4. Exceção REV.SEM_AUTORIZACAO — DOC-07 §3 (Passos 1 | motivo obrigatório
-- | expira 8h). Catalogada só agora que o gate-in de devolução (RN-REV-002)
-- é o primeiro chamador real.
-- =============================================================================
INSERT INTO wms.exception_type (code, name, default_steps, requires_reason, auto_expire_hours, created_by) VALUES
  ('REV.SEM_AUTORIZACAO', 'Retorno sem Ordem de Devolução autorizada (DOC-07 RN-REV-002)', 1, TRUE, 8, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 5. RD-REV-003 — wms.recall (TENANT, RLS). Sem warehouse_id: o lote (TENANT,
-- sem coluna de armazém) pode ter saldo em vários armazéns — o recall é uma
-- ação por CLIENTE×LOTE, não por armazém. `triggering_warehouse_id` guarda
-- só o armazém de onde a ação foi disparada (contexto de auditoria/permissão
-- CLIENT_WAREHOUSE), não o alcance do efeito (RN-REV-030: "em TODOS os
-- armazéns").
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.recall (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES wms.batch(id) ON DELETE RESTRICT,
  triggering_warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  -- RF-REV-030 item 4: relatório de rastreabilidade (pedidos já expedidos
  -- com o lote) — snapshot no momento do acionamento, imutável (RG-003).
  shipped_orders_report JSONB NOT NULL DEFAULT '[]',
  qty_blocked NUMERIC(18,6) NOT NULL DEFAULT 0,
  qty_reservations_cancelled NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  CONSTRAINT recall_qty_blocked_check CHECK (qty_blocked >= 0),
  CONSTRAINT recall_qty_reservations_cancelled_check CHECK (qty_reservations_cancelled >= 0)
);

CREATE INDEX IF NOT EXISTS idx_recall_batch ON wms.recall (batch_id);
CREATE INDEX IF NOT EXISTS idx_recall_tenant ON wms.recall (tenant_id);

ALTER TABLE wms.recall ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.recall FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recall_tenant_isolation ON wms.recall;
CREATE POLICY recall_tenant_isolation ON wms.recall
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT ON wms.recall TO wms_app;
-- RG-003: recall é fato histórico imutável (append-only) — sem UPDATE.
REVOKE UPDATE ON wms.recall FROM wms_app;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (72, 'DOC-07 9B: gate-in de devolucao (SEM_AUTORIZACAO_REVERSA), RECUSA_ENTREGA/RECALL no catalogo de tipos, REV.RECALL, REV.SEM_AUTORIZACAO, wms.recall', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
