// TESTE DE CONTRATO DE PERMISSÕES — RG-001/ADR-006 (least privilege).
//
// Por que este teste existe: em TRÊS sessões seguidas (5A, 5A e 5B) um job
// cross-tenant novo passou a ler uma tabela que `wms_worker` nunca havia
// tocado, e o GRANT faltante só apareceu quando um teste de integração
// específico daquele job falhou com "permission denied for table X" — tarde,
// e por acaso. `tsc` nunca pega isso; RLS não protege contra isso; e a falta
// de um GRANT só se manifesta no caminho de código que usa aquela tabela.
//
// O contrato abaixo inverte a ordem: a lista declarada é a fonte de verdade,
// e QUALQUER divergência falha imediatamente, incluindo tabela nova que
// ninguém decidiu conceder. Ao adicionar uma tabela ou um consumidor novo, a
// escolha de privilégios passa a ser um ato explícito e revisável no diff —
// não um efeito colateral descoberto depois.
//
// Três verificações:
//   1. privilégios REAIS == privilégios DECLARADOS, tabela a tabela;
//   2. nenhuma tabela do schema fora da lista (força a decisão);
//   3. toda PARTIÇÃO tem os mesmos privilégios do seu pai — GRANT no pai
//      particionado NÃO propaga no Postgres (bug real corrigido na migration
//      0046 para stock_movement), então a regra é verificada, não presumida.
import { Pool } from 'pg';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from './test-setup.helper.js';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

interface TableGrants {
  wms_app: Privilege[];
  wms_worker: Privilege[];
}

const S: Privilege[] = ['SELECT'];
const SI: Privilege[] = ['SELECT', 'INSERT'];
const SIU: Privilege[] = ['SELECT', 'INSERT', 'UPDATE'];
const SIUD: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const SU: Privilege[] = ['SELECT', 'UPDATE'];
const NONE: Privilege[] = [];

/**
 * Contrato declarado. `wms_worker` (ADR-006, BYPASSRLS) só aparece onde um
 * job cross-tenant REALMENTE precisa — cada entrada não-vazia abaixo tem um
 * consumidor identificável; ao remover um job, remova o grant.
 *
 * Tabelas particionadas são declaradas pelo PAI; as partições são cobertas
 * pela verificação 3 (herança), não listadas uma a uma (nascem e somem por
 * mês).
 */
const DECLARED_GRANTS: Record<string, TableGrants> = {
  // ── Núcleo/infra (DOC-01) ──────────────────────────────────────────────
  app_parameter: { wms_app: SIUD, wms_worker: S }, // workers leem parâmetros (REC.CROSSDOCK_TEMPO_MAX_H, EST.ALERTA_VENCIMENTO_DIAS)
  event_outbox: { wms_app: SIUD, wms_worker: SIU }, // outbox-publisher: lê, marca publicado, e republica (RNF-ARQ-033)
  rls_probe: { wms_app: SIUD, wms_worker: NONE },
  schema_migration: { wms_app: NONE, wms_worker: NONE }, // só o bootstrap das migrations escreve
  sync_operation: { wms_app: SIUD, wms_worker: S }, // DOC-15 COL-1: SyncStatusService (T8) lê a fila por device_id, cross-tenant
  edge_agent: { wms_app: SIUD, wms_worker: NONE },
  // ── Periféricos (DOC-11) — GLOBAL, sem RLS (mesmo raciocínio de
  // warehouse/zone/location): dispositivo físico e fila de job são
  // infraestrutura do armazém, não dado de tenant. edge_agent_job
  // (migration 0007) foi DROPADA nesta sessão — ver comentário na
  // migration 0063.
  peripheral_device: { wms_app: SIU, wms_worker: NONE },
  workstation: { wms_app: SIU, wms_worker: NONE },
  workstation_device: { wms_app: SIU, wms_worker: NONE },
  label_template: { wms_app: SIU, wms_worker: NONE },
  // PeripheralJobService/LprService publicam evento (event_outbox, RLS) NA
  // MESMA transação da escrita de negócio — só possível via wms_worker
  // (BYPASSRLS, ADR-006), então a escrita também roda nesse papel
  // (migration 0065; mesmo raciocínio de alert/chat_room, DOC-10).
  lpr_reading: { wms_app: SIU, wms_worker: SI },
  peripheral_job: { wms_app: SIU, wms_worker: SU }, // particionada — cobertura de partição pela verificação 3

  // ── Campo/PWA de coletor (DOC-15 COL-1) — GLOBAL, mesmo raciocínio de
  // peripheral_device: dispositivo é infraestrutura do armazém.
  field_device: { wms_app: SIU, wms_worker: S }, // DOC-15 RNF-COL-051: FieldDeviceOfflineWorkerImpl varre dispositivos sem contato > 24h

  // ── Cadastros (DOC-02) ─────────────────────────────────────────────────
  client: { wms_app: SIU, wms_worker: S }, // DOC-10: OperationsBoardService lê nome do cliente cross-tenant no painel
  client_warehouse_settings: { wms_app: SIU, wms_worker: S }, // RG-006: política de giro padrão, lida pela seleção no kanban (5B)
  warehouse: { wms_app: SIU, wms_worker: S }, // DOC-10: timezone lido por KpiMaterializationService.resolveWarehouseLocalDate
  zone: { wms_app: SIU, wms_worker: S }, // JIT/CROSS_DOCKING na seleção (5B)
  storage_equipment: { wms_app: SIU, wms_worker: S }, // RN-DAD-010/LIFO_PHYSICAL na seleção (5B)
  location: { wms_app: SIU, wms_worker: S }, // seleção e kanban (5A/5B)
  logical_warehouse: { wms_app: SIU, wms_worker: S }, // RG-015 item 1 na seleção (5B)
  logical_warehouse_location: { wms_app: SIUD, wms_worker: NONE }, // item 2 é lido via SECURITY DEFINER, não direto
  product: { wms_app: SIU, wms_worker: S }, // trigger RN-DAD-020 dispara no INSERT de saldo pelo worker
  product_species: { wms_app: SIU, wms_worker: S }, // idem
  product_packaging: { wms_app: SIU, wms_worker: NONE },
  product_barcode: { wms_app: SIU, wms_worker: NONE },
  product_warehouse_parameter: { wms_app: SIU, wms_worker: SU }, // RF-EST-040: dedup do alerta de estoque de segurança
  commercial_category: { wms_app: SIU, wms_worker: NONE },
  batch: { wms_app: SIU, wms_worker: S }, // RN-EST-014: job de vencimento
  pallet: { wms_app: SIU, wms_worker: S }, // DOC-15 COL-1: MyTasksService (T1) exibe o LPN do palete de cada tarefa de putaway, cross-tenant
  pallet_content: { wms_app: SIU, wms_worker: NONE },
  document_sequence: { wms_app: SIU, wms_worker: NONE },
  yard_slot: { wms_app: SIU, wms_worker: NONE },

  // ── Saldos e movimentação (DOC-02/DOC-05) ──────────────────────────────
  stock_balance: { wms_app: SIU, wms_worker: SIU }, // RN-EST-014 bloqueia saldo vencido via StockMovementService
  stock_movement: { wms_app: SI, wms_worker: SI }, // append-only (UPDATE/DELETE revogados, migration 0014)
  fiscal_stock_balance: { wms_app: SIU, wms_worker: NONE },
  // ── Fiscal (DOC-08/Sessão 8A) ───────────────────────────────────────────
  operation_nature: { wms_app: SIU, wms_worker: NONE },
  fiscal_document: { wms_app: SIU, wms_worker: S }, // InboundInvoiceFiscalService (worker de alerta de prazo RN-FIS-010) calcula cobertura cross-tenant
  fiscal_document_item: { wms_app: SIU, wms_worker: S }, // idem
  fiscal_allocation: { wms_app: SIU, wms_worker: NONE },
  fiscal_pending_document: { wms_app: SIU, wms_worker: NONE },
  // ── Fiscal (DOC-08/Sessão 8B) — motor de emissão NF-e ──────────────────
  fiscal_issuer: { wms_app: SIU, wms_worker: S }, // jobs do scheduler (alerta de expiração de certificado, monitor de disponibilidade SEFAZ) varrem emitentes cross-tenant; escrita sempre via db.transaction(ctx,...) com o tenant já conhecido
  fiscal_document_event: { wms_app: SIU, wms_worker: S }, // FiscalNumberInutilizacaoWorkerImpl faz NOT EXISTS contra esta tabela no scan cross-tenant; escrita continua só via wms_app
  stock_block_reason: { wms_app: SIU, wms_worker: NONE },
  stock_reclassification: { wms_app: SIU, wms_worker: NONE },
  // 5B: reserva nasce em request; a EXPIRAÇÃO dela (DOC-06 RN-EXP-003) é job.
  stock_reservation: { wms_app: SIU, wms_worker: SU },
  stock_transfer: { wms_app: SIU, wms_worker: S }, // DOC-15 COL-2A: ShiftPackageService (Pacote de Turno) lê pool do armazém
  stock_transfer_item: { wms_app: SIU, wms_worker: S }, // idem
  stock_transfer_operation: { wms_app: SIU, wms_worker: NONE }, // DOC-15 COL-2A: idempotência de operationId (RNF-ARQ-050) em StockTransferService.transferInternal — UPDATE herdado do default ACL (migration 0010)
  replenishment_task: { wms_app: SIU, wms_worker: SI }, // RF-EST-041: kanban gera a tarefa no scheduler
  replenishment_operation: { wms_app: SIU, wms_worker: NONE },

  // ── Segurança e auditoria (DOC-12) ─────────────────────────────────────
  user: { wms_app: SIU, wms_worker: NONE },
  user_password_history: { wms_app: SI, wms_worker: NONE },
  user_role_assignment: { wms_app: SIU, wms_worker: NONE },
  role: { wms_app: SIU, wms_worker: NONE },
  role_permission: { wms_app: SIU, wms_worker: NONE },
  permission: { wms_app: SIU, wms_worker: NONE },
  auth_session: { wms_app: SIU, wms_worker: NONE },
  login_attempt: { wms_app: SI, wms_worker: NONE },
  audit_log: { wms_app: SI, wms_worker: NONE }, // imutável (RG-003)
  approval_authority: { wms_app: SIU, wms_worker: NONE },
  exception_type: { wms_app: SIU, wms_worker: S }, // RN-SEG-042: worker lê auto_expire_hours
  operational_exception: { wms_app: SIU, wms_worker: SU }, // RN-SEG-042: expira vencidas
  operational_exception_decision: { wms_app: SIU, wms_worker: NONE },
  operation_flow: { wms_app: SIU, wms_worker: S }, // DOC-10: painel cross-tenant (RF-PAI-001)
  flow_step: { wms_app: SIU, wms_worker: S }, // DOC-10: painel cross-tenant (RF-PAI-001)

  // ── Portaria e pátio (DOC-03) ──────────────────────────────────────────
  appointment: { wms_app: SIU, wms_worker: SU }, // RN-POR-004: NO_SHOW
  appointment_window_config: { wms_app: SIU, wms_worker: S },
  appointment_window_occupancy: { wms_app: SIU, wms_worker: NONE },
  vehicle: { wms_app: SIU, wms_worker: S },
  vehicle_visit: { wms_app: SIU, wms_worker: S },
  driver: { wms_app: SIU, wms_worker: NONE },
  visitor: { wms_app: SIU, wms_worker: NONE },
  person_visit: { wms_app: SIU, wms_worker: NONE },
  yard_queue_entry: { wms_app: SIU, wms_worker: SU },

  // ── Recebimento (DOC-04) ───────────────────────────────────────────────
  inbound_order: { wms_app: SIU, wms_worker: S }, // DOC-10: painel cross-tenant (RF-PAI-001)
  inbound_order_item: { wms_app: SIU, wms_worker: S }, // DOC-10 K-04: join até discrepancy
  inbound_invoice: { wms_app: SIU, wms_worker: S }, // DOC-08/8A: InboundInvoiceFiscalService (worker de alerta de prazo RN-FIS-010) varre cross-tenant
  dock: { wms_app: SIU, wms_worker: NONE },
  dock_zone_distance: { wms_app: SIU, wms_worker: NONE },
  checking: { wms_app: SIU, wms_worker: S }, // DOC-15 COL-2A: ShiftPackageService (Pacote de Turno) lê pool do armazém
  checking_item: { wms_app: SIU, wms_worker: S }, // idem
  checking_operation: { wms_app: SIU, wms_worker: NONE }, // DOC-15 COL-2A: idempotência de operationId (RNF-ARQ-050) em CheckingService.countFirstRound/recount — UPDATE herdado do default ACL (migration 0010), mesmo padrão de putaway_operation/replenishment_operation
  discrepancy: { wms_app: SIU, wms_worker: S }, // DOC-10 K-04: % ordens com divergência
  crossdock_link: { wms_app: SIU, wms_worker: S }, // RNF-REC-052: aging
  putaway_task: { wms_app: SIU, wms_worker: S }, // DOC-10 K-03: dock-to-stock
  putaway_operation: { wms_app: SIU, wms_worker: NONE },

  // ── Expedição (DOC-06) ─────────────────────────────────────────────────
  outbound_order: { wms_app: SIU, wms_worker: SU }, // RN-EXP-003: job de expiração de reserva
  outbound_order_item: { wms_app: SIU, wms_worker: SU }, // RN-EXP-003: job zera o reservado do item
  wave: { wms_app: SIU, wms_worker: NONE },
  wave_order: { wms_app: SIU, wms_worker: NONE },
  // ── Expedição — Sessão 6B (picking/packing/pesagem/carregamento) ────────
  picking_task: { wms_app: SIU, wms_worker: S }, // DOC-10 K-15: produtividade de picking
  package_type: { wms_app: SIU, wms_worker: NONE },
  package: { wms_app: SIU, wms_worker: NONE },
  package_content: { wms_app: SI, wms_worker: NONE },
  loading: { wms_app: SIU, wms_worker: S }, // DOC-10 K-06/K-07: OTIF e lead time via loading->vehicle_visit
  loading_order: { wms_app: SI, wms_worker: S }, // DOC-10 K-06/K-07: join outbound_order->loading
  loading_scan: { wms_app: SI, wms_worker: NONE },
  // DOC-05 5C: inventory_count é o cabeçalho/documento (novo);
  // inventory_count_location é a célula (ex-inventory_count da 6B, ganhou
  // UPDATE aqui — [DEBITO: 5C] fechado); inventory_count_round é append-only.
  inventory_count: { wms_app: SIU, wms_worker: S }, // DOC-10 K-12: acuracidade de endereço
  inventory_count_location: { wms_app: SIU, wms_worker: S }, // DOC-15 COL-2A: ShiftPackageService (Pacote de Turno) lê pool do armazém
  inventory_count_round: { wms_app: SI, wms_worker: NONE },
  inventory_count_operation: { wms_app: SIU, wms_worker: NONE }, // DOC-15 COL-2A: idempotência de operationId (RNF-ARQ-050) em InventoryCountExecutionService.submitRound — UPDATE herdado do default ACL (migration 0010)
  // DOC-10: kpi_daily/kpi_event_applied só o worker de materialização
  // escreve (transactionAsWorker, RN-PAI-042); wms_app só lê kpi_daily
  // (dashboard). alert/alert_read/chat_room: wms_app escreve em tempo de
  // requisição (exceção aguardando alçada, marcar lido, enviar mensagem);
  // alert também recebe alertas materializados por worker (Edge Agent,
  // lote a vencer, cartão atrasado). chat_message é append-only
  // (RF-PAI-030 "mensagens são imutáveis").
  kpi_daily: { wms_app: S, wms_worker: SIU },
  kpi_event_applied: { wms_app: NONE, wms_worker: SI },
  alert: { wms_app: SIU, wms_worker: SIU },
  alert_read: { wms_app: SI, wms_worker: S }, // AlertService.list/countUnread (cross-cliente, transactionAsWorker)
  chat_room: { wms_app: SI, wms_worker: SI }, // ChatService (transactionAsWorker, sala armazém-turno cross-cliente)
  chat_message: { wms_app: SI, wms_worker: SI }, // idem
  user_board_preference: { wms_app: SIU, wms_worker: NONE },

  // ── Logística Reversa (DOC-07) — Sessão 9A ──────────────────────────────
  return_order: { wms_app: SIU, wms_worker: S }, // DOC-10 painel (operations-board, transactionAsWorker) lê cross-tenant desde a 10A/DOC-17
  return_order_item: { wms_app: SIU, wms_worker: NONE },
  triage_record: { wms_app: SIU, wms_worker: NONE },
  // ── Logística Reversa (DOC-07) — Sessão 9B (Recall, RF-REV-030) ─────────
  recall: { wms_app: SI, wms_worker: NONE }, // RG-003: fato histórico imutável, sem UPDATE
};

interface GrantRow {
  table_name: string;
  grantee: string;
  privileges: string[];
}

function sortPrivileges(privileges: string[]): string[] {
  return [...privileges].sort();
}

/**
 * ACL lida direto de pg_class.relacl (via aclexplode), NÃO de
 * information_schema.role_table_grants: a view do information_schema só expõe
 * grants em que o usuário corrente é grantor/grantee ou membro do grantee — e
 * este teste roda como `wms_app`, que enxergaria ZERO grants de `wms_worker` e
 * passaria em falso. O catálogo é visível a qualquer usuário e traz a ACL
 * completa. (Erro cometido na primeira versão deste teste; o meta-teste ao
 * final do arquivo existe para impedir que ele volte despercebido.)
 */
const ACL_QUERY = `
  SELECT c.relname AS table_name,
         a.grantee::regrole::text AS grantee,
         array_agg(DISTINCT a.privilege_type) AS privileges
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'wms'
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relkind IN ('r', 'p')
    AND a.grantee::regrole::text IN ('wms_app', 'wms_worker')
    AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  GROUP BY c.relname, a.grantee`;

function indexGrants(rows: GrantRow[]): Map<string, { wms_app: string[]; wms_worker: string[] }> {
  const index = new Map<string, { wms_app: string[]; wms_worker: string[] }>();
  for (const row of rows) {
    const entry = index.get(row.table_name) ?? { wms_app: [], wms_worker: [] };
    entry[row.grantee as 'wms_app' | 'wms_worker'] = sortPrivileges(row.privileges);
    index.set(row.table_name, entry);
  }
  return index;
}

/** Divergências entre contrato e realidade, para um dos dois papéis. */
function findDivergences(actual: Map<string, { wms_app: string[]; wms_worker: string[] }>, existingTables: string[], role: 'wms_app' | 'wms_worker'): string[] {
  const divergences: string[] = [];
  for (const [table, expected] of Object.entries(DECLARED_GRANTS)) {
    if (!existingTables.includes(table)) continue;
    const real = actual.get(table)?.[role] ?? [];
    const want = sortPrivileges(expected[role]);
    if (JSON.stringify(real) !== JSON.stringify(want)) {
      divergences.push(`${table}: declarado [${want.join(',')}] × real [${real.join(',')}]`);
    }
  }
  return divergences;
}

describe('Contrato de permissões do schema wms (ADR-006, least privilege)', () => {
  let testContext: TestContext;
  let actualByTable: Map<string, { wms_app: string[]; wms_worker: string[] }>;
  let baseTables: string[];
  let partitions: Array<{ child: string; parent: string }>;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();

    const grants = await testContext.databaseService.queryGlobal<GrantRow>(ACL_QUERY);
    actualByTable = indexGrants(grants.rows);

    // Tabelas BASE = tudo que não é partição de outra tabela.
    const tables = await testContext.databaseService.queryGlobal<{ relname: string }>(
      `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'wms' AND c.relkind IN ('r', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
       ORDER BY c.relname`
    );
    baseTables = tables.rows.map((r) => r.relname);

    const partitionRows = await testContext.databaseService.queryGlobal<{ child: string; parent: string }>(
      `SELECT child.relname AS child, parent.relname AS parent
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = child.relnamespace AND n.nspname = 'wms'`
    );
    partitions = partitionRows.rows;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('toda tabela do schema está declarada no contrato (tabela nova exige decisão explícita de grant)', () => {
    const undeclared = baseTables.filter((t) => !(t in DECLARED_GRANTS));
    expect(
      undeclared,
      `Tabela(s) sem entrada em DECLARED_GRANTS: ${undeclared.join(', ')}. ` +
        `Adicione a entrada declarando explicitamente os privilégios de wms_app e wms_worker — ` +
        `inclusive quando wms_worker não deve ter nenhum (use NONE).`
    ).toEqual([]);
  });

  it('nenhuma entrada do contrato aponta para tabela inexistente', () => {
    const declared = Object.keys(DECLARED_GRANTS);
    const missing = declared.filter((t) => !baseTables.includes(t));
    expect(missing, `Entrada(s) em DECLARED_GRANTS sem tabela correspondente: ${missing.join(', ')}`).toEqual([]);
  });

  it('privilégios reais de wms_app conferem com o contrato', () => {
    const divergences = findDivergences(actualByTable, baseTables, 'wms_app');
    expect(divergences, `Divergência de privilégios de wms_app:\n  ${divergences.join('\n  ')}`).toEqual([]);
  });

  it('privilégios reais de wms_worker conferem com o contrato (ADR-006: só o que um job cross-tenant precisa)', () => {
    const divergences = findDivergences(actualByTable, baseTables, 'wms_worker');
    expect(
      divergences,
      `Divergência de privilégios de wms_worker:\n  ${divergences.join('\n  ')}\n` +
        `Se um job novo passou a ler/escrever a tabela, conceda o GRANT na migration E atualize DECLARED_GRANTS.`
    ).toEqual([]);
  });

  it('toda partição herda os mesmos privilégios do pai (GRANT no pai particionado NÃO propaga)', () => {
    // Regra derivada, não lista fixa: partições nascem e somem por mês.
    // Este é o bug real corrigido na migration 0046 — o GRANT em
    // wms.stock_movement não alcançava as partições já existentes, e o
    // worker falhava só ao tentar INSERIR numa delas.
    expect(partitions.length).toBeGreaterThan(0); // sanidade: o schema tem tabelas particionadas

    const divergences: string[] = [];
    for (const { child, parent } of partitions) {
      for (const role of ['wms_app', 'wms_worker'] as const) {
        const parentPrivileges = actualByTable.get(parent)?.[role] ?? [];
        const childPrivileges = actualByTable.get(child)?.[role] ?? [];
        if (JSON.stringify(parentPrivileges) !== JSON.stringify(childPrivileges)) {
          divergences.push(`${child} (${role}): pai ${parent} tem [${parentPrivileges.join(',')}], partição tem [${childPrivileges.join(',')}]`);
        }
      }
    }
    expect(
      divergences,
      `Partição com privilégios diferentes do pai:\n  ${divergences.join('\n  ')}\n` +
        `Conceda também na função ensure_*_partition() (partições futuras) E retroativamente às já existentes.`
    ).toEqual([]);
  });

  /**
   * META-TESTE — prova que a verificação DETECTA de fato uma divergência.
   *
   * Um contrato que passa porque não enxerga nada é pior que nenhum contrato:
   * dá falsa segurança exatamente onde o bug se esconde. A primeira versão
   * deste arquivo tinha esse defeito (lia information_schema como `wms_app` e
   * via zero grants de `wms_worker`). Este teste injeta a divergência real —
   * revoga o SELECT de `wms_worker` em `wms.batch`, o mesmo tipo de grant que
   * faltou em três sessões seguidas — confirma que ela é apontada, e
   * restaura no `finally`.
   */
  it('META: a verificação realmente detecta um grant revogado de wms_worker', async () => {
    const adminPool = new Pool({
      host: testContext.configService.get('POSTGRES_HOST', 'localhost'),
      port: parseInt(testContext.configService.get('POSTGRES_PORT', '5432'), 10),
      database: testContext.configService.get('POSTGRES_DB', 'wms_db'),
      user: 'postgres',
      password: process.env.POSTGRES_ADMIN_PASSWORD || 'postgres_root_password',
    });

    try {
      await adminPool.query('REVOKE SELECT ON wms.batch FROM wms_worker');

      const afterRevoke = await testContext.databaseService.queryGlobal<GrantRow>(ACL_QUERY);
      const divergences = findDivergences(indexGrants(afterRevoke.rows), baseTables, 'wms_worker');

      expect(divergences).toContain('batch: declarado [SELECT] × real []');
    } finally {
      await adminPool.query('GRANT SELECT ON wms.batch TO wms_worker').catch(() => {});
      await adminPool.end().catch(() => {});
    }

    // Restaurado: a verificação volta a passar limpa.
    const restored = await testContext.databaseService.queryGlobal<GrantRow>(ACL_QUERY);
    expect(findDivergences(indexGrants(restored.rows), baseTables, 'wms_worker')).toEqual([]);
  });
});
