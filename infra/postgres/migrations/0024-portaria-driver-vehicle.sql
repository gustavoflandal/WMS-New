-- Migration: 0024
-- DOC-03 RD-POR-002/003 — driver, vehicle (GLOBAL, RN-DAD-004: reaproveitados
-- por CPF/placa entre visitas, sem tenant_id — RF-POR-011).

-- =============================================================================
-- wms.is_valid_cpf — mesmo padrao de wms.is_valid_cnpj (migration 0008):
-- modulo 11, pesos 10-9-8-7-6-5-4-3-2 / 11-10-9-8-7-6-5-4-3-2, rejeita
-- sequencias de digito unico.
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.is_valid_cpf(p_cpf TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  digits INT[];
  i INT;
  sum1 INT := 0;
  sum2 INT := 0;
  weights1 INT[] := ARRAY[10,9,8,7,6,5,4,3,2];
  weights2 INT[] := ARRAY[11,10,9,8,7,6,5,4,3,2];
  dv1 INT;
  dv2 INT;
BEGIN
  IF p_cpf IS NULL OR p_cpf !~ '^[0-9]{11}$' THEN
    RETURN FALSE;
  END IF;

  -- Sequencias de digito unico (00000000000 etc.) passam matematicamente
  -- no modulo 11 mas nao sao CPFs validos.
  IF p_cpf ~ '^(\d)\1{10}$' THEN
    RETURN FALSE;
  END IF;

  FOR i IN 1..11 LOOP
    digits[i] := substring(p_cpf FROM i FOR 1)::INT;
  END LOOP;

  FOR i IN 1..9 LOOP
    sum1 := sum1 + digits[i] * weights1[i];
  END LOOP;
  dv1 := 11 - (sum1 % 11);
  IF dv1 >= 10 THEN dv1 := 0; END IF;

  FOR i IN 1..10 LOOP
    sum2 := sum2 + digits[i] * weights2[i];
  END LOOP;
  dv2 := 11 - (sum2 % 11);
  IF dv2 >= 10 THEN dv2 := 0; END IF;

  RETURN digits[10] = dv1 AND digits[11] = dv2;
END;
$$;

-- =============================================================================
-- driver — RD-POR-002 (GLOBAL). Mascaramento de CPF/CNH em exibicao e
-- responsabilidade da aplicacao (RN-SEG-051, POR.DADO_PESSOAL_COMPLETO
-- para exibicao completa) — o dado e persistido em claro aqui, como todo
-- dado pessoal ja tratado desta forma no sistema (ex. wms.user).
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.driver (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cpf TEXT NOT NULL,
  name TEXT NOT NULL,
  cnh TEXT NOT NULL,
  cnh_validity DATE NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT driver_cpf_unique UNIQUE (cpf),
  CONSTRAINT driver_cpf_format CHECK (cpf ~ '^[0-9]{11}$'),
  CONSTRAINT driver_cpf_valid CHECK (wms.is_valid_cpf(cpf)),
  CONSTRAINT driver_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.driver TO wms_app;

-- =============================================================================
-- vehicle — RD-POR-003 (GLOBAL). Placa validada nos dois padroes citados em
-- RF-POR-010: Mercosul (AAA9A99) e anterior (AAA9999).
-- vehicle_type: DOC-03 nao enumera os tipos de veiculo aceitos (RF-POR-001
-- so cita "tipo de veiculo" sem lista) — [LACUNA: DOC-03 nao define enum de
-- tipo de veiculo] modelado como TEXT livre, nao um CHECK fechado.
-- trailer1_plate/trailer2_plate: RD-POR-003 cita "reboques" como atributo
-- do proprio vehicle (nao por visita) — modelagem adotada literalmente do
-- dicionario de dados.
-- =============================================================================
CREATE TABLE IF NOT EXISTS wms.vehicle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  trailer1_plate TEXT,
  trailer2_plate TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  CONSTRAINT vehicle_plate_unique UNIQUE (plate),
  CONSTRAINT vehicle_plate_format CHECK (
    plate ~ '^[A-Z]{3}[0-9][A-Z][0-9]{2}$'  -- Mercosul: AAA9A99
    OR plate ~ '^[A-Z]{3}[0-9]{4}$'         -- anterior: AAA9999
  ),
  CONSTRAINT vehicle_trailer1_format CHECK (
    trailer1_plate IS NULL OR trailer1_plate ~ '^[A-Z]{3}[0-9][A-Z][0-9]{2}$' OR trailer1_plate ~ '^[A-Z]{3}[0-9]{4}$'
  ),
  CONSTRAINT vehicle_trailer2_format CHECK (
    trailer2_plate IS NULL OR trailer2_plate ~ '^[A-Z]{3}[0-9][A-Z][0-9]{2}$' OR trailer2_plate ~ '^[A-Z]{3}[0-9]{4}$'
  ),
  CONSTRAINT vehicle_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

GRANT SELECT, INSERT, UPDATE ON wms.vehicle TO wms_app;
-- RF-POR-020: YardQueueService.listQueue() faz JOIN com vehicle cross-tenant
-- via transactionAsWorker (vehicle é GLOBAL, mas a pool wms_worker também
-- precisa de GRANT explícito — BYPASSRLS não concede privilégio de tabela).
GRANT SELECT ON wms.vehicle TO wms_worker;

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (24, 'DOC-03 RD-POR-002/003: wms.is_valid_cpf, driver, vehicle (GLOBAL, no RLS)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
