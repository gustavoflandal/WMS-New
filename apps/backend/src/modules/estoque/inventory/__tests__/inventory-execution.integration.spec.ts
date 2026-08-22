// DOC-05 §4.7 (Sessão 5C) — Inventários contra Postgres real: os 7 tipos de
// escopo (RF-EST-060), congelamento (RN-EST-061), as 3 rodadas de contagem
// com os 2 cenários normativos do §6 (RN-EST-062), ajuste com alçada
// (RN-EST-063) e acuracidade (RF-EST-064).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { ZoneService } from '../../../cadastro/zone/zone.service.js';
import { BatchService } from '../../../cadastro/batch/batch.service.js';
import { DocumentNumberingService } from '../../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../../core/workflow/operational-exception.service.js';
import { PasswordService } from '../../../../core/auth/password.service.js';
import { InventoryPlanningService } from '../inventory-planning.service.js';
import { InventoryCountExecutionService } from '../inventory-count-execution.service.js';
import { StockMovementService } from '../../movement/stock-movement.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../../core/__tests__/security-test-helpers.js';

describe('Estoque - DOC-05 §4.7 Inventários (Sessão 5C)', () => {
  let testContext: TestContext;

  let planningService: InventoryPlanningService;
  let executionService: InventoryCountExecutionService;
  let productService: ProductService;
  let zoneService: ZoneService;
  let batchService: BatchService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;

  /** EST.INVENTARIO_CONTAR — operadores da 1ª/2ª rodada. */
  let inv1: { id: string };
  let inv2: { id: string };
  /** EST.INVENTARIO_CONTAR + papel LIDER_TURNO — única combinação que passa a 3ª rodada. */
  let liderInv: { id: string };
  /** EST.INVENTARIO_PLANEJAR + EST.INVENTARIO_APROVAR_AJUSTE (GESTOR_ARMAZEM). */
  let gestor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const exceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const stockMovementService = new StockMovementService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    const passwordService = new PasswordService(db);

    planningService = new InventoryPlanningService(db, eventsService, documentNumberingService);
    executionService = new InventoryCountExecutionService(db, eventsService, auditService, exceptionService, stockMovementService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    zoneService = new ZoneService(db, auditService);
    batchService = new BatchService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém 5C', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente 5C', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FEFO', blind_checking: true },
      SEED_ACTOR_ID
    );
    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;

    inv1 = await createTestUser(db, passwordService);
    inv2 = await createTestUser(db, passwordService);
    liderInv = await createTestUser(db, passwordService);
    gestor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: inv1.id, roleCode: 'INVENTARIANTE', warehouseId, clientId });
    await assignRole(db, { userId: inv2.id, roleCode: 'INVENTARIANTE', warehouseId, clientId });
    await assignRole(db, { userId: liderInv.id, roleCode: 'INVENTARIANTE', warehouseId, clientId });
    await assignRole(db, { userId: liderInv.id, roleCode: 'LIDER_TURNO', warehouseId, clientId });
    await assignRole(db, { userId: gestor.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });

    // EST.INV_ROTATIVO_QTD_DIA — cleanTestData() (test-setup.helper.ts) apaga
    // wms.app_parameter a cada arquivo; sem isto o default (20) mascararia o
    // teste de desempate ABC com poucos endereços. INSERT precisa de contexto
    // de tenant (app_parameter tem RLS mesmo para linhas GLOBAL, migration
    // 0004) — queryGlobal() não define app.tenant_ids e falha o WITH CHECK.
    await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'EST.INV_ROTATIVO_QTD_DIA', '2')`
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  let locationSeq = 0;
  async function createLocation(opts: { zoneId?: string; abcClass?: 'A' | 'B' | 'C' } = {}) {
    locationSeq += 1;
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, abc_class, status, created_by)
       VALUES ($1,$2,'A1',$3,'00','01','STORAGE',5000,100,5,5,$4,'ACTIVE',$5) RETURNING *`,
      [warehouseId, opts.zoneId ?? storageZoneId, String(locationSeq).padStart(3, '0'), opts.abcClass ?? null, SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  async function createProduct(speciesCode = 'GERAL') {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto 5C', species_code: speciesCode, base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' },
      SEED_ACTOR_ID
    );
  }

  async function seedBalance(productId: string, locationId: string, qty: number, batchId: string | null = null) {
    await rawAuthorizedQuery(
      testContext.databaseService,
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, batch_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [clientId, warehouseId, productId, locationId, batchId, qty, SEED_ACTOR_ID]
    );
  }

  async function locationStatus(locationId: string): Promise<string> {
    const result = await testContext.databaseService.queryGlobal(`SELECT status FROM wms.location WHERE id = $1`, [locationId]);
    return result.rows[0].status;
  }

  /**
   * Leitura tenant-scoped: inventory_count/inventory_count_location/
   * operational_exception têm RLS (mesmo em linhas de um único tenant) —
   * queryGlobal() usa o pool wms_app SEM contexto de sessão e sempre bate
   * 0 linhas (achado desta sessão, ver comentário no INSERT de app_parameter
   * acima). wms.location não tem RLS, por isso locationStatus()/createLocation()
   * seguem via queryGlobal() sem problema.
   */
  async function tenantQuery<T = any>(sql: string, params: unknown[] = []) {
    return testContext.databaseService.query<T>({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, sql, params);
  }

  // ───────────────────────────────────────────────────────────────────────
  // RF-EST-060 — geração de escopo, 7 tipos
  // ───────────────────────────────────────────────────────────────────────
  describe('RF-EST-060 — geração de escopo', () => {
    it('GERAL: inclui todos os endereços com saldo; com include_empty também os vazios', async () => {
      const product = await createProduct();
      const loc1 = await createLocation();
      const loc2 = await createLocation();
      const emptyLoc = await createLocation();
      await seedBalance(product.id, loc1.id, 10);
      await seedBalance(product.id, loc2.id, 20);

      const withoutEmpty = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'GERAL', actorUserId: gestor.id });
      expect(withoutEmpty.locationCount).toBe(2);

      const withEmpty = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'GERAL', includeEmpty: true, actorUserId: gestor.id });
      expect(withEmpty.locationCount).toBe(3);
      void emptyLoc;
    });

    it('ROTATIVO_PRODUTO: só endereços com saldo dos produtos selecionados', async () => {
      const productA = await createProduct();
      const productB = await createProduct();
      const locA = await createLocation();
      const locB = await createLocation();
      await seedBalance(productA.id, locA.id, 5);
      await seedBalance(productB.id, locB.id, 5);

      const result = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'ROTATIVO_PRODUTO', productIds: [productA.id], actorUserId: gestor.id });
      expect(result.locationCount).toBe(1);
      expect(result.cellCount).toBe(1);
    });

    it('POR_ZONA: só endereços das zonas selecionadas', async () => {
      const otherZone = await zoneService.create({ warehouse_id: warehouseId, code: `Z${Date.now() % 100000}`, name: 'Outra zona', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
      const product = await createProduct();
      const locIn = await createLocation({ zoneId: otherZone.id });
      const locOut = await createLocation();
      await seedBalance(product.id, locIn.id, 5);
      await seedBalance(product.id, locOut.id, 5);

      const result = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ZONA', zoneIds: [otherZone.id], actorUserId: gestor.id });
      expect(result.locationCount).toBe(1);
    });

    it('POR_ESPECIE: só endereços com saldo das espécies selecionadas', async () => {
      const alimento = await createProduct('ALIMENTO');
      const geral = await createProduct('GERAL');
      const locAlimento = await createLocation();
      const locGeral = await createLocation();
      // ALIMENTO tem requires_batch=true (DOC-02 §5.3) — stock_balance exige batch_id.
      const batch = await batchService.create({ tenant_id: clientId, product_id: alimento.id, batch_code: `L-${Date.now()}`, expiration_date: '2027-01-01' }, SEED_ACTOR_ID);
      await seedBalance(alimento.id, locAlimento.id, 5, batch.id);
      await seedBalance(geral.id, locGeral.id, 5);

      const result = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ESPECIE', species: ['ALIMENTO'], actorUserId: gestor.id });
      expect(result.locationCount).toBe(1);
    });

    it('POR_ENDERECO: lista explícita de endereços', async () => {
      const product = await createProduct();
      const loc1 = await createLocation();
      const loc2 = await createLocation();
      await seedBalance(product.id, loc1.id, 5);
      await seedBalance(product.id, loc2.id, 5);

      const result = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc1.id], actorUserId: gestor.id });
      expect(result.locationCount).toBe(1);
    });

    it('POR_SORTEIO [§6 "sorteio reprodutível"]: mesma semente produz sempre a mesma lista de endereços', async () => {
      const product = await createProduct();
      const locations = [];
      for (let i = 0; i < 6; i += 1) {
        const loc = await createLocation();
        await seedBalance(product.id, loc.id, 1);
        locations.push(loc.id);
      }
      const seed = `seed-${Date.now()}`;

      const first = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_SORTEIO', randomSeed: seed, sampleSize: 3, actorUserId: gestor.id });
      const second = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_SORTEIO', randomSeed: seed, sampleSize: 3, actorUserId: gestor.id });

      const cellsFirst = await tenantQuery(`SELECT location_id FROM wms.inventory_count_location WHERE header_id = $1 ORDER BY location_id`, [
        first.headerId,
      ]);
      const cellsSecond = await tenantQuery(`SELECT location_id FROM wms.inventory_count_location WHERE header_id = $1 ORDER BY location_id`, [
        second.headerId,
      ]);
      // Afirma não-vazio ANTES de comparar os dois lados — um bug de RLS
      // silenciosa já fez esta asserção passar comparando [] com [] sem
      // nunca ter lido uma linha real (ver CLAUDE.md "Testes: nunca
      // comparar dois resultados possivelmente vazios").
      expect(cellsFirst.rows.length).toBeGreaterThan(0);
      expect(cellsSecond.rows.map((r: any) => r.location_id)).toEqual(cellsFirst.rows.map((r: any) => r.location_id));
      expect(first.locationCount).toBe(3);
    });

    it('ROTATIVO_DIA: desempate por classe ABC (A primeiro) quando nenhum endereço foi contado ainda', async () => {
      const product = await createProduct();
      const locC = await createLocation({ abcClass: 'C' });
      const locA = await createLocation({ abcClass: 'A' });
      const locB = await createLocation({ abcClass: 'B' });
      await seedBalance(product.id, locC.id, 1);
      await seedBalance(product.id, locA.id, 1);
      await seedBalance(product.id, locB.id, 1);

      // EST.INV_ROTATIVO_QTD_DIA = 2 (seedado no beforeAll).
      const result = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'ROTATIVO_DIA', actorUserId: gestor.id });
      const cells = await tenantQuery(`SELECT location_id FROM wms.inventory_count_location WHERE header_id = $1`, [result.headerId]);
      const pickedIds = cells.rows.map((r: any) => r.location_id);
      expect(pickedIds).toHaveLength(2);
      expect(pickedIds).toContain(locA.id);
      expect(pickedIds).toContain(locB.id);
      expect(pickedIds).not.toContain(locC.id);
    });

    it('escopo vazio é rejeitado', async () => {
      await expect(
        planningService.plan({ tenantId: clientId, warehouseId, countType: 'ROTATIVO_PRODUTO', productIds: ['00000000-0000-0000-0000-000000000099'], actorUserId: gestor.id })
      ).rejects.toMatchObject({ response: { error: 'EMPTY_SCOPE' } });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EST-061 [INVIOLÁVEL] — congelamento
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-EST-061 — congelamento de endereço', () => {
    it('start() congela todos os endereços do escopo; §5.1 só PLANNED pode ser cancelado', async () => {
      const product = await createProduct();
      const loc = await createLocation();
      await seedBalance(product.id, loc.id, 10);

      const planned = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc.id], actorUserId: gestor.id });
      expect(await locationStatus(loc.id)).toBe('ACTIVE');

      const started = await planningService.start(clientId, warehouseId, planned.headerId, gestor.id);
      expect(await locationStatus(loc.id)).toBe('INVENTORY');
      expect((started.header as any).status).toBe('IN_PROGRESS');

      await expect(planningService.cancel(clientId, warehouseId, planned.headerId, gestor.id)).rejects.toMatchObject({
        response: { error: 'INVENTORY_NOT_CANCELLABLE' },
      });
    });

    it('cancel() antes de iniciar não toca nenhum endereço', async () => {
      const product = await createProduct();
      const loc = await createLocation();
      await seedBalance(product.id, loc.id, 10);

      const planned = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc.id], actorUserId: gestor.id });
      const cancelled = await planningService.cancel(clientId, warehouseId, planned.headerId, gestor.id);
      expect((cancelled as any).status).toBe('CANCELLED');
      expect(await locationStatus(loc.id)).toBe('ACTIVE');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EST-062 [INVIOLÁVEL] — rodadas de contagem (exemplos normativos §6)
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-EST-062 — rodadas de contagem', () => {
    async function planAndStart(qty: number) {
      const product = await createProduct();
      const loc = await createLocation();
      await seedBalance(product.id, loc.id, qty);
      const planned = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc.id], actorUserId: gestor.id });
      await planningService.start(clientId, warehouseId, planned.headerId, gestor.id);
      const cell = await tenantQuery(`SELECT * FROM wms.inventory_count_location WHERE header_id = $1`, [planned.headerId]);
      return { headerId: planned.headerId, locationId: loc.id, cellId: cell.rows[0].id };
    }

    it('exemplo normativo §6 — sistema 100, 1ª 95 (João), 2ª 95 (Maria) -> divergência confirmada de -5, EST.AJUSTE_INVENTARIO aberta', async () => {
      const { cellId } = await planAndStart(100);

      const round1 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv1.id });
      expect(round1).toEqual({ status: 'AWAITING_ROUND', nextRound: 2 });

      // RN-EST-062: mesma pessoa não pode fazer a 2ª rodada.
      await expect(executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv1.id })).rejects.toMatchObject({
        response: { error: 'SAME_OPERATOR_ROUND2' },
      });

      const round2 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv2.id });
      expect(round2.status).toBe('ADJUSTMENT_PENDING');
      expect((round2 as any).divergence).toBe(-5);

      const exception = await tenantQuery(`SELECT * FROM wms.operational_exception WHERE id = $1`, [(round2 as any).exceptionId]);
      expect(exception.rows[0].exception_type).toBe('EST.AJUSTE_INVENTARIO');
      expect(Number(exception.rows[0].qty)).toBe(5);
    });

    it('exemplo normativo §6 — sistema 100, 1ª 95, 2ª 98, 3ª (LIDER_TURNO) 98 -> divergência confirmada de -2', async () => {
      const { cellId } = await planAndStart(100);

      await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv1.id });
      const round2 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 98, actorUserId: inv2.id });
      expect(round2).toEqual({ status: 'AWAITING_ROUND', nextRound: 3 });

      // RN-EST-062: 3ª rodada exige o papel LIDER_TURNO — inv1 tem EST.INVENTARIO_CONTAR mas não o papel.
      await expect(executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 98, actorUserId: inv1.id })).rejects.toMatchObject({
        response: { error: 'LIDER_TURNO_REQUIRED' },
      });

      const round3 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 98, actorUserId: liderInv.id });
      expect(round3.status).toBe('ADJUSTMENT_PENDING');
      expect((round3 as any).divergence).toBe(-2);
    });

    it('1ª rodada bate com o sistema -> célula concluída sem ajuste, endereço liberado, header concluído (RF-EST-064)', async () => {
      const { cellId, locationId, headerId } = await planAndStart(50);

      const round1 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 50, actorUserId: inv1.id });
      expect(round1).toEqual({ status: 'COMPLETED' });
      expect(await locationStatus(locationId)).toBe('ACTIVE');

      const header = await tenantQuery(`SELECT * FROM wms.inventory_count WHERE id = $1`, [headerId]);
      expect(header.rows[0].status).toBe('COMPLETED');
      expect(Number(header.rows[0].accuracy_location)).toBe(1);
      expect(Number(header.rows[0].accuracy_quantity)).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EST-063 — ajuste com alçada
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-EST-063 — ajuste com alçada', () => {
    it('ajuste APROVADO posta AJUSTE_INVENTARIO_NEG, fecha a célula, libera o endereço e conclui o cabeçalho', async () => {
      const product = await createProduct();
      const loc = await createLocation();
      await seedBalance(product.id, loc.id, 100);
      const planned = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc.id], actorUserId: gestor.id });
      await planningService.start(clientId, warehouseId, planned.headerId, gestor.id);
      const cellResult = await tenantQuery(`SELECT * FROM wms.inventory_count_location WHERE header_id = $1`, [planned.headerId]);
      const cellId = cellResult.rows[0].id;

      await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv1.id });
      const round2 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv2.id });
      const exceptionId = (round2 as any).exceptionId;

      const decision = await executionService.decideAdjustment({ tenantId: clientId, warehouseId, exceptionId, decision: 'APPROVE', reason: 'Confirmado', actorUserId: gestor.id });
      expect((decision as any).movementType).toBe('AJUSTE_INVENTARIO_NEG');

      const balance = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT qty_available FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
        [product.id, loc.id]
      );
      expect(Number(balance.rows[0].qty_available)).toBe(95);
      expect(await locationStatus(loc.id)).toBe('ACTIVE');

      const cell = await tenantQuery(`SELECT status FROM wms.inventory_count_location WHERE id = $1`, [cellId]);
      expect(cell.rows[0].status).toBe('COMPLETED');

      const header = await tenantQuery(`SELECT status FROM wms.inventory_count WHERE id = $1`, [planned.headerId]);
      expect(header.rows[0].status).toBe('COMPLETED');
    });

    it('ajuste REJEITADO exige nova contagem (RN-EST-063: "volta à 1ª rodada")', async () => {
      const product = await createProduct();
      const loc = await createLocation();
      await seedBalance(product.id, loc.id, 100);
      const planned = await planningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [loc.id], actorUserId: gestor.id });
      await planningService.start(clientId, warehouseId, planned.headerId, gestor.id);
      const cellResult = await tenantQuery(`SELECT * FROM wms.inventory_count_location WHERE header_id = $1`, [planned.headerId]);
      const cellId = cellResult.rows[0].id;

      await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv1.id });
      const round2 = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 95, actorUserId: inv2.id });
      const exceptionId = (round2 as any).exceptionId;

      const decision = await executionService.decideAdjustment({ tenantId: clientId, warehouseId, exceptionId, decision: 'REJECT', reason: 'Recontar', actorUserId: gestor.id });
      expect((decision as any).status).toBe('PENDING');
      expect((decision as any).cycle).toBe(2);

      // Nova contagem — bate com o sistema desta vez -> concluído.
      const freshRound = await executionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 100, actorUserId: inv1.id });
      expect(freshRound).toEqual({ status: 'COMPLETED' });
      expect(await locationStatus(loc.id)).toBe('ACTIVE');
    });
  });
});
