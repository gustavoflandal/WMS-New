-- Migration: 0030
-- DOC-03 RN-POR-002 — capacidade de janela "por armazém" (nao por cliente):
-- QUALQUER cliente disputa a MESMA capacidade de uma janela fisica do
-- armazem. Isso exige uma contagem CROSS-TENANT, mas wms.appointment tem
-- RLS (RG-001 [INVIOLAVEL], migration 0027) — uma conexao com contexto de
-- um tenant nao pode enxergar agendamentos de outro para somar a ocupacao.
--
-- Solucao adotada: tabela GLOBAL (sem tenant_id, sem RLS — mesmo padrao de
-- wms.document_sequence) que mantem o contador de ocupacao por
-- (window_config_id, window_date), atualizada atomicamente por triggers
-- SECURITY DEFINER em wms.appointment. A checagem de capacidade acontece
-- DENTRO do trigger BEFORE INSERT (lock de linha via FOR UPDATE serializa
-- concorrencia, mesmo espirito de RNF-ARQ-021 ja usado em
-- document_sequence) — nao no service, evitando corrida entre "checar" e
-- "reservar" em requisicoes concorrentes de clientes diferentes.

CREATE TABLE IF NOT EXISTS wms.appointment_window_occupancy (
  window_config_id UUID NOT NULL REFERENCES wms.appointment_window_config(id) ON DELETE RESTRICT,
  window_date DATE NOT NULL,
  occupied_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (window_config_id, window_date)
);

GRANT SELECT ON wms.appointment_window_occupancy TO wms_app;
-- INSERT/UPDATE feitos exclusivamente pelas funcoes SECURITY DEFINER
-- abaixo (donas do objeto pelo owner da migration) — wms_app so precisa
-- de leitura direta (consulta de ocupacao historica no Gherkin de no-show).

-- =============================================================================
-- Reserva capacidade no INSERT (RN-POR-002: "e PROIBIDO overbooking").
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.check_and_reserve_appointment_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_capacity INT;
  v_current INT;
BEGIN
  IF NEW.status NOT IN ('SCHEDULED', 'CONFIRMED_ARRIVAL') THEN
    RETURN NEW;
  END IF;

  SELECT capacity INTO v_capacity FROM wms.appointment_window_config WHERE id = NEW.window_config_id;
  IF v_capacity IS NULL THEN
    RAISE EXCEPTION 'RD-POR-007: appointment_window_config % nao encontrada', NEW.window_config_id
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO wms.appointment_window_occupancy (window_config_id, window_date, occupied_count)
  VALUES (NEW.window_config_id, NEW.window_date, 0)
  ON CONFLICT (window_config_id, window_date) DO NOTHING;

  SELECT occupied_count INTO v_current FROM wms.appointment_window_occupancy
  WHERE window_config_id = NEW.window_config_id AND window_date = NEW.window_date
  FOR UPDATE;

  IF v_current + 1 > v_capacity THEN
    RAISE EXCEPTION 'RN-POR-002: janela sem capacidade disponivel (capacidade=%, ocupacao=%)', v_capacity, v_current
      USING ERRCODE = '23514';
  END IF;

  UPDATE wms.appointment_window_occupancy SET occupied_count = occupied_count + 1
  WHERE window_config_id = NEW.window_config_id AND window_date = NEW.window_date;

  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_capacity_reserve
  BEFORE INSERT ON wms.appointment
  FOR EACH ROW EXECUTE FUNCTION wms.check_and_reserve_appointment_capacity();

-- =============================================================================
-- Libera capacidade quando o status sai de SCHEDULED/CONFIRMED_ARRIVAL
-- (RF-POR-003 cancelamento, RN-POR-004 no-show).
-- =============================================================================
CREATE OR REPLACE FUNCTION wms.release_appointment_capacity_on_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF OLD.status IN ('SCHEDULED', 'CONFIRMED_ARRIVAL') AND NEW.status NOT IN ('SCHEDULED', 'CONFIRMED_ARRIVAL') THEN
    UPDATE wms.appointment_window_occupancy SET occupied_count = GREATEST(occupied_count - 1, 0)
    WHERE window_config_id = OLD.window_config_id AND window_date = OLD.window_date;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_capacity_release
  AFTER UPDATE ON wms.appointment
  FOR EACH ROW EXECUTE FUNCTION wms.release_appointment_capacity_on_status_change();

-- Record migration
INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (30, 'DOC-03 RN-POR-002: appointment_window_occupancy (GLOBAL) + triggers de reserva/liberacao atomica de capacidade', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
