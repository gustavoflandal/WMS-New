-- Migration: 0028
-- DOC-03 RD-POR-005 — vehicle_visit (TENANT, RLS padrao ADR-RLS-003/004).
-- Documento raiz da portaria (§2): ciclo completo do veiculo no site,
-- maquina de estados §5.1. yard_slot.slot_type ja inclui 'HAZMAT' desde a
-- Sessao 2A (migration 0008) — reaproveitado literalmente para RN-POR-013.

-- Postgres nao permite subquery (nem EXISTS) em CHECK constraint direto na
-- tabela — validacao de cada elemento do array precisa de uma funcao
-- IMMUTABLE separada, mesmo padrao de wms.is_valid_cpf/is_valid_cnpj.
CREATE OR REPLACE FUNCTION wms.all_nfe_keys_valid(p_keys TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  k TEXT;
BEGIN
  IF p_keys IS NULL THEN
    RETURN TRUE;
  END IF;
  FOREACH k IN ARRAY p_keys LOOP
    IF k !~ '^[0-9]{44}$' THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE TABLE IF NOT EXISTS wms.vehicle_visit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES wms.client(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES wms.warehouse(id) ON DELETE RESTRICT,
  appointment_id UUID REFERENCES wms.appointment(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL,
  vehicle_id UUID NOT NULL REFERENCES wms.vehicle(id) ON DELETE RESTRICT,
  driver_id UUID NOT NULL REFERENCES wms.driver(id) ON DELETE RESTRICT,
  carrier_name TEXT,
  carrier_cnpj TEXT,
  -- RF-POR-011: chaves de NF-e (44 digitos, validadas na aplicacao —
  -- digito verificador de chave de NF-e e modulo 11 com peso variavel
  -- especifico da SEFAZ, fora do escopo de reimplementar em SQL aqui;
  -- validacao de FORMATO (44 digitos numericos) e feita via CHECK).
  nfe_keys TEXT[] NOT NULL DEFAULT '{}',
  seals_in TEXT[] NOT NULL DEFAULT '{}',
  seals_out TEXT[] NOT NULL DEFAULT '{}',
  photo_url TEXT,
  km NUMERIC(10, 1),
  status TEXT NOT NULL DEFAULT 'CHEGADA_REGISTRADA',
  -- blocking_reason: motivo de permanencia em AGUARDANDO_AUTORIZACAO
  -- (RN-POR-012/013) — NAO e coluna livre de setStatus(), apenas contexto
  -- auxiliar consultado pela aplicacao; a maquina de estados em si e
  -- inteiramente controlada por VehicleVisitService.transition().
  blocking_reason TEXT,
  yard_slot_id UUID REFERENCES wms.yard_slot(id) ON DELETE RESTRICT,
  dock_id UUID REFERENCES wms.dock(id) ON DELETE RESTRICT,
  contains_hazmat BOOLEAN NOT NULL DEFAULT FALSE,
  contains_perishable BOOLEAN NOT NULL DEFAULT FALSE,
  -- operation_flow_completed: RN-POR-040 exige validar "Fluxo Operacional
  -- sem etapas pendentes" (inbound: descarga+documentos; outbound:
  -- Carregamento+documentos fiscais) antes do gate-out. [LACUNA: DOC-04
  -- (descarga/conferencia) e DOC-06 (Carregamento/expedicao) nao existem
  -- nesta sessao — nao ha Fluxo Operacional real para consultar.] Campo
  -- substituto explicito ate esses modulos existirem e passarem a mante-lo
  -- automaticamente; por ora e setado manualmente pela camada de aplicacao
  -- (ex.: testes, ou uma futura tela administrativa).
  operation_flow_completed BOOLEAN NOT NULL DEFAULT FALSE,
  -- RNF-POR-042: timestamps de marcos para KPIs de permanencia (DOC-10).
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorized_at TIMESTAMPTZ,
  gate_in_at TIMESTAMPTZ,
  yard_slot_at TIMESTAMPTZ,
  dock_call_at TIMESTAMPTZ,
  dock_at TIMESTAMPTZ,
  gate_out_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT vehicle_visit_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  -- §5.1: maquina de estados completa.
  CONSTRAINT vehicle_visit_status_check CHECK (status IN (
    'CHEGADA_REGISTRADA', 'AGUARDANDO_AUTORIZACAO', 'NO_PATIO',
    'EM_DESLOCAMENTO_DOCA', 'EM_DOCA', 'LIBERADO_SAIDA', 'ENCERRADA', 'RECUSADO'
  )),
  -- SEM_VAGA_DISPONIVEL: DOC-03 so descreve o comportamento de "sem vaga
  -- livre" explicitamente para HAZMAT (RN-POR-013). [LACUNA: DOC-03 nao
  -- define o comportamento quando nao ha NENHUMA vaga comum livre para um
  -- veiculo nao-HAZMAT] — modelado por analogia direta a RN-POR-013 (mesmo
  -- padrao AGUARDANDO_AUTORIZACAO + alerta), nao inventando uma regra nova.
  CONSTRAINT vehicle_visit_blocking_reason_check CHECK (
    blocking_reason IS NULL OR blocking_reason IN ('SEM_AGENDAMENTO', 'FORA_DA_JANELA', 'SEM_VAGA_HAZMAT', 'SEM_VAGA_DISPONIVEL')
  ),
  CONSTRAINT vehicle_visit_nfe_keys_format CHECK (wms.all_nfe_keys_valid(nfe_keys))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_visit_warehouse_status ON wms.vehicle_visit (warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_vehicle_visit_tenant ON wms.vehicle_visit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_visit_appointment ON wms.vehicle_visit (appointment_id);

ALTER TABLE wms.vehicle_visit ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms.vehicle_visit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_visit_tenant_isolation ON wms.vehicle_visit;
CREATE POLICY vehicle_visit_tenant_isolation ON wms.vehicle_visit
  FOR ALL
  USING (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  )
  WITH CHECK (
    NULLIF(current_setting('app.tenant_ids', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID
  );

GRANT SELECT, INSERT, UPDATE ON wms.vehicle_visit TO wms_app;
-- RF-POR-020: YardQueueService.listQueue() faz JOIN com vehicle_visit
-- cross-tenant via transactionAsWorker (ver nota de débito em yard-queue.service.ts).
GRANT SELECT ON wms.vehicle_visit TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (28, 'DOC-03 RD-POR-005: vehicle_visit (TENANT, RLS) - maquina de estados §5.1', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
