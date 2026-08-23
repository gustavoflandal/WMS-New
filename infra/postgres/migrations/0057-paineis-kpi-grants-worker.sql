-- Migration: 0057
-- DOC-10 RN-PAI-041/042 — KpiComputationService/KpiMaterializationService
-- rodam via transactionAsWorker (BYPASSRLS, cross-tenant por natureza,
-- mesmo raciocínio de OperationsBoardService). wms_worker nunca havia lido
-- estas 6 tabelas: warehouse (timezone, resolveWarehouseLocalDate), dock+
-- putaway_task (K-03), discrepancy (K-04), loading (K-06/K-07),
-- inventory_count (K-12), picking_task (K-15). GRANT explícito por
-- consumidor, mesmo achado recorrente (ver CLAUDE.md).

GRANT SELECT ON wms.warehouse TO wms_worker;
GRANT SELECT ON wms.putaway_task TO wms_worker;
GRANT SELECT ON wms.discrepancy TO wms_worker;
GRANT SELECT ON wms.loading TO wms_worker;
GRANT SELECT ON wms.loading_order TO wms_worker;
GRANT SELECT ON wms.inventory_count TO wms_worker;
GRANT SELECT ON wms.picking_task TO wms_worker;
GRANT SELECT ON wms.inbound_order_item TO wms_worker;

-- putaway_task e picking_task são particionadas (RNF-ARQ-090) — GRANT no
-- pai NÃO propaga para partições já existentes (mesmo achado de
-- stock_movement, migration 0046). Retroativo e idempotente.
DO $$
DECLARE
  v_partition RECORD;
BEGIN
  FOR v_partition IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'wms.putaway_task'::regclass
  LOOP
    EXECUTE format('GRANT SELECT ON wms.%I TO wms_worker', v_partition.relname);
  END LOOP;

  FOR v_partition IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'wms.picking_task'::regclass
  LOOP
    EXECUTE format('GRANT SELECT ON wms.%I TO wms_worker', v_partition.relname);
  END LOOP;
END
$$;

INSERT INTO wms.schema_migration (version, description, type, installed_by, execution_time)
VALUES (57, 'DOC-10: GRANT SELECT a wms_worker em warehouse/putaway_task/discrepancy/loading/inventory_count/picking_task para KpiComputationService', 'SQL', 'system', 0)
ON CONFLICT (version) DO NOTHING;
