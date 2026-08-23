// DOC-15 (Sessão COL-1) — plataforma PWA de coletor: registro de
// dispositivo (RNF-COL-003), PIN (RF-SEG-004/RF-COL-030), T1 (Minhas
// Tarefas), T7 (Consulta), T8 (Sincronização).
import { v4 as uuid } from 'uuid';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';
import { FieldDeviceService } from '../field-device/field-device.service.js';
import { PinService } from '../pin/pin.service.js';
import { MyTasksService } from '../my-tasks/my-tasks.service.js';
import { StockSearchService } from '../stock-search/stock-search.service.js';
import { SyncStatusService } from '../sync-status/sync-status.service.js';

describe('DOC-15 Sessão COL-1 — plataforma PWA de coletor (dispositivo, PIN, T1/T7/T8)', () => {
  let testContext: TestContext;
  let fieldDeviceService: FieldDeviceService;
  let pinService: PinService;
  let myTasksService: MyTasksService;
  let stockSearchService: StockSearchService;
  let syncStatusService: SyncStatusService;

  let warehouseId: string;
  let clientId: string;
  let zoneId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const passwordService = new PasswordService(db);
    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    fieldDeviceService = new FieldDeviceService(db, auditService);
    pinService = new PinService(db, auditService, passwordService);
    myTasksService = new MyTasksService(db);
    stockSearchService = new StockSearchService(db);
    syncStatusService = new SyncStatusService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém COL-1', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente COL-1', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    zoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createLocation(code: string) {
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'C1',$3,'00','01','STORAGE',5000,100,5,5,'ACTIVE',$4) RETURNING *`,
      [warehouseId, zoneId, code, SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  // ─────────────────────────────────────────────────────────────────────
  // RNF-COL-003 — Registro de dispositivo
  // ─────────────────────────────────────────────────────────────────────
  describe('RNF-COL-003 — field_device', () => {
    it('registra um dispositivo novo e, no segundo contato, atualiza last_seen_at (idempotente por device_id)', async () => {
      const deviceId = uuid();
      const first = await fieldDeviceService.registerOrTouch({ deviceId, warehouseId, userAgent: 'Chrome Android', appVersion: '1.0.0', actorUserId: SEED_ACTOR_ID });
      expect(first.status).toBe('ACTIVE');
      expect(first.device_id).toBe(deviceId);

      const second = await fieldDeviceService.registerOrTouch({ deviceId, warehouseId, appVersion: '1.0.1', actorUserId: SEED_ACTOR_ID });
      expect(second.id).toBe(first.id); // mesma linha, não duplicada
      expect(second.app_version).toBe('1.0.1');
    });

    it('dispositivo bloqueado (COL.DISPOSITIVO_GERIR) rejeita novo contato', async () => {
      const deviceId = uuid();
      const device = await fieldDeviceService.registerOrTouch({ deviceId, warehouseId, actorUserId: SEED_ACTOR_ID });
      await fieldDeviceService.block(device.id, warehouseId, SEED_ACTOR_ID);

      await expect(fieldDeviceService.registerOrTouch({ deviceId, warehouseId, actorUserId: SEED_ACTOR_ID })).rejects.toMatchObject({
        response: { error: 'DEVICE_BLOCKED' },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // RF-SEG-004/RF-COL-030 — PIN
  // ─────────────────────────────────────────────────────────────────────
  describe('RF-SEG-004/RF-COL-030 — PIN de re-bloqueio', () => {
    it('sem PIN definido, verificar rejeita com PIN_NOT_SET', async () => {
      const user = await createTestUser(testContext.databaseService, new PasswordService(testContext.databaseService));
      await expect(pinService.verifyPin(user.id, '123456', warehouseId)).rejects.toMatchObject({ response: { error: 'PIN_NOT_SET' } });
    });

    it('PIN correto autentica; PIN errado 3x bloqueia e exige login completo', async () => {
      const user = await createTestUser(testContext.databaseService, new PasswordService(testContext.databaseService));
      await pinService.setPin(user.id, '135790');

      const ok = await pinService.verifyPin(user.id, '135790', warehouseId);
      expect(ok).toEqual({ ok: true, requiresFullLogin: false });

      await pinService.verifyPin(user.id, '000000', warehouseId).catch(() => {});
      await pinService.verifyPin(user.id, '000000', warehouseId).catch(() => {});
      await expect(pinService.verifyPin(user.id, '000000', warehouseId)).rejects.toMatchObject({ response: { error: 'PIN_LOCKED_AFTER_FAILURES' } });

      // 4ª tentativa, mesmo com o PIN CERTO, é rejeitada (bloqueado por 15 min).
      await expect(pinService.verifyPin(user.id, '135790', warehouseId)).rejects.toMatchObject({ response: { error: 'PIN_LOCKED' } });
    });

    it('rejeita PIN com formato inválido (não 6 dígitos)', async () => {
      const user = await createTestUser(testContext.databaseService, new PasswordService(testContext.databaseService));
      await expect(pinService.setPin(user.id, '123')).rejects.toMatchObject({ response: { error: 'INVALID_PIN_FORMAT' } });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // T1 — Minhas Tarefas
  // ─────────────────────────────────────────────────────────────────────
  describe('DOC-15 §4.5 T1 — Minhas Tarefas (cross-módulo, cross-tenant)', () => {
    it('lista putaway_task e replenishment_task atribuídas ao operador; ignora as de outro operador ou não atribuídas', async () => {
      const operatorA = await createTestUser(testContext.databaseService, new PasswordService(testContext.databaseService));
      const operatorB = await createTestUser(testContext.databaseService, new PasswordService(testContext.databaseService));
      const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };

      const product = await new ProductService(testContext.databaseService, new AuditService(testContext.databaseService)).create(
        { tenant_id: clientId, sku: randomSku(), description: 'Produto COL-1', species_code: 'GERAL', base_uom: 'UN' },
        SEED_ACTOR_ID
      );
      const locOrigin = await createLocation('101');
      const locDest = await createLocation('102');

      const palletResult = await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.pallet (tenant_id, lpn, pallet_type, status, created_by) VALUES ($1, $2, 'PBR', 'STORED', $3) RETURNING *`,
        [clientId, String(Date.now()).padStart(18, '0').slice(-18), SEED_ACTOR_ID]
      );
      const pallet = palletResult.rows[0];

      // Tarefa A: putaway atribuída ao operador A.
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.putaway_task (tenant_id, warehouse_id, pallet_id, location_id_designated, assigned_to_user_id, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6)`,
        [clientId, warehouseId, pallet.id, locDest.id, operatorA.id, SEED_ACTOR_ID]
      );
      // Tarefa B: reposição atribuída ao operador A.
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.replenishment_task (tenant_id, warehouse_id, product_id, trigger_type, location_id_origin, location_id_destination, qty, assigned_to_user_id, status, created_by)
         VALUES ($1,$2,$3,'MANUAL',$4,$5,10,$6,'ASSIGNED',$7)`,
        [clientId, warehouseId, product.id, locOrigin.id, locDest.id, operatorA.id, SEED_ACTOR_ID]
      );
      // Tarefa C: putaway do operador B (não deve aparecer para A).
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.putaway_task (tenant_id, warehouse_id, pallet_id, location_id_designated, assigned_to_user_id, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6)`,
        [clientId, warehouseId, pallet.id, locDest.id, operatorB.id, SEED_ACTOR_ID]
      );
      // Tarefa D: reposição sem atribuição (não deve aparecer).
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.replenishment_task (tenant_id, warehouse_id, product_id, trigger_type, location_id_origin, location_id_destination, qty, status, created_by)
         VALUES ($1,$2,$3,'MANUAL',$4,$5,5,'CREATED',$6)`,
        [clientId, warehouseId, product.id, locOrigin.id, locDest.id, SEED_ACTOR_ID]
      );

      const myTasks = await myTasksService.listMyTasks(warehouseId, operatorA.id);
      expect(myTasks).toHaveLength(2);
      const putawayTask = myTasks.find((t) => t.type === 'PUTAWAY');
      const replenishmentTask = myTasks.find((t) => t.type === 'REPOSICAO');
      expect(putawayTask?.lpn).toBe(pallet.lpn);
      expect(putawayTask?.locationCode).toBe(locDest.code);
      expect(replenishmentTask?.productSku).toBe(product.sku);
      expect(replenishmentTask?.qty).toBe(10);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // T7 — Consulta
  // ─────────────────────────────────────────────────────────────────────
  describe('DOC-15 §4.5 T7 — Consulta (RN-EST-061: congelado nunca revela qty_available)', () => {
    it('retorna saldo por SKU; endereço INVENTORY aparece com qty_available=null e frozenByInventory=true', async () => {
      const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
      const product = await new ProductService(testContext.databaseService, new AuditService(testContext.databaseService)).create(
        { tenant_id: clientId, sku: randomSku(), description: 'Produto Consulta COL-1', species_code: 'GERAL', base_uom: 'UN' },
        SEED_ACTOR_ID
      );
      const activeLocation = await createLocation('201');
      const frozenLocation = await createLocation('202');
      await testContext.databaseService.queryGlobal(`UPDATE wms.location SET status = 'INVENTORY' WHERE id = $1`, [frozenLocation.id]);

      await rawAuthorizedQuery(
        testContext.databaseService,
        ctx,
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,50,$5)`,
        [clientId, warehouseId, product.id, activeLocation.id, SEED_ACTOR_ID]
      );
      await rawAuthorizedQuery(
        testContext.databaseService,
        ctx,
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,30,$5)`,
        [clientId, warehouseId, product.id, frozenLocation.id, SEED_ACTOR_ID]
      );

      const results = await stockSearchService.search(product.sku, clientId, warehouseId, SEED_ACTOR_ID);
      expect(results.length).toBeGreaterThan(0); // afirma não-vazio antes de comparar (CLAUDE.md)
      expect(results).toHaveLength(2);

      const activeRow = results.find((r) => r.locationCode === activeLocation.code);
      const frozenRow = results.find((r) => r.locationCode === frozenLocation.code);
      expect(activeRow?.qtyAvailable).toBe(50);
      expect(activeRow?.frozenByInventory).toBe(false);
      expect(frozenRow?.qtyAvailable).toBeNull();
      expect(frozenRow?.frozenByInventory).toBe(true);
      expect(frozenRow?.locationStatus).toBe('INVENTORY');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // T8 — Sincronização
  // ─────────────────────────────────────────────────────────────────────
  describe('DOC-15 §4.5 T8 — Sincronização (reflete wms.sync_operation, sem produtor em COL-1)', () => {
    it('sem nenhuma sync_operation para o device: todos os contadores zerados', async () => {
      const status = await syncStatusService.getStatus(uuid());
      expect(status).toEqual({ deviceId: expect.any(String), pending: 0, synced: 0, conflict: 0, failed: 0 });
    });

    it('agrega corretamente por status quando existem linhas (inseridas diretamente — sem produtor real ainda)', async () => {
      const deviceId = uuid();
      const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.sync_operation (tenant_id, warehouse_id, device_id, operation_type, entity_type, entity_id, entity_data, status, idempotency_key)
         VALUES ($1,$2,$3,'CREATE','putaway_task',$4,'{}','PENDING',$5)`,
        [clientId, warehouseId, deviceId, uuid(), uuid()]
      );
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.sync_operation (tenant_id, warehouse_id, device_id, operation_type, entity_type, entity_id, entity_data, status, idempotency_key)
         VALUES ($1,$2,$3,'CREATE','putaway_task',$4,'{}','SYNCED',$5)`,
        [clientId, warehouseId, deviceId, uuid(), uuid()]
      );

      const status = await syncStatusService.getStatus(deviceId);
      expect(status.pending).toBe(1);
      expect(status.synced).toBe(1);
      expect(status.conflict).toBe(0);
      expect(status.failed).toBe(0);
    });
  });
});
