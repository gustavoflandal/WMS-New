-- Migration: 0065
-- DOC-11 — PeripheralJobService.applyAgentResult()/sweepExpiredJobs() e
-- LprService.receiveReading() publicam evento (perifericos.job_concluido/
-- job_falha/placa_lida) NA MESMA transação que a escrita de negócio.
-- wms.event_outbox tem RLS (migration 0003) e peripheral_job/lpr_reading
-- não têm tenant_id utilizável como contexto de RLS (jobs/leituras são
-- cross-tenant por natureza — mesmo dispositivo físico atende vários
-- clientes) — a única forma de publicar o evento nessa transação é
-- BYPASSRLS (wms_worker, ADR-006), então a escrita de negócio da MESMA
-- transação também precisa rodar como wms_worker. Mesmo padrão já usado
-- por alert/chat_room (DOC-10). Achado ao rodar a suíte real (erro real:
-- "new row violates row-level security policy for table event_outbox"),
-- não hipotético — mesmo princípio de CLAUDE.md/GRANT por consumidor real.

GRANT SELECT, UPDATE ON wms.peripheral_job TO wms_worker;
GRANT SELECT, INSERT ON wms.lpr_reading TO wms_worker;

-- peripheral_job é particionada — GRANT no pai NÃO propaga (mesmo achado
-- de stock_movement, migration 0046): retroativo nas partições já
-- existentes (bootstrap da migration 0063) e a função de partição futura.
DO $$
DECLARE
  v_partition RECORD;
BEGIN
  FOR v_partition IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'wms.peripheral_job'::regclass
  LOOP
    EXECUTE format('GRANT SELECT, UPDATE ON wms.%I TO wms_worker', v_partition.relname);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION wms.ensure_peripheral_job_partition(p_year INT, p_month INT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wms, pg_temp
AS $$
DECLARE
  v_partition_name TEXT;
  v_start DATE;
  v_end DATE;
BEGIN
  v_partition_name := format('peripheral_job_y%s_m%s', p_year, lpad(p_month::text, 2, '0'));
  v_start := make_date(p_year, p_month, 1);
  v_end := (v_start + INTERVAL '1 month')::date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name AND relnamespace = 'wms'::regnamespace
  ) THEN
    EXECUTE format(
      'CREATE TABLE wms.%I PARTITION OF wms.peripheral_job FOR VALUES FROM (%L) TO (%L)',
      v_partition_name, v_start, v_end
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON wms.%I TO wms_app', v_partition_name);
    EXECUTE format('GRANT SELECT, UPDATE ON wms.%I TO wms_worker', v_partition_name);
  END IF;

  RETURN v_partition_name;
END;
$$;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (65, 'DOC-11: GRANT wms_worker em peripheral_job (+particoes)/lpr_reading para publicacao de evento na mesma transacao (ADR-006)', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
