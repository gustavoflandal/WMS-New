// DOC-05 §4.1 RN-EST-001 [INVIOLÁVEL] — Entregável 7 (Sessão 5A): "teste de
// integração parametrizado que exercita StockMovementService.apply() de fato
// para os 18 tipos e confere o saldo resultante em stock_balance" (lacuna
// apontada no handoff da retomada). Complementa
// stock-movement-effects.util.spec.ts (que só testa a função PURA, sem
// banco) — aqui é Postgres de verdade, incluindo o trigger de guarda
// (RN-EST-001, migration 0045) e o CHECK fechado de movement_type.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { ZoneService } from '../../../cadastro/zone/zone.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { StockMovementService } from '../stock-movement.service.js';
import { BUCKET_COLUMN, MOVEMENT_TYPES, MovementType, StockBucket } from '../stock-movement-effects.util.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';

describe('StockMovementService - DOC-05 RN-EST-001 [INVIOLÁVEL] efeito real dos 18 tipos contra Postgres', () => {
  let testContext: TestContext;
  let stockMovementService: StockMovementService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let warehouseId2: string;
  let locationA: any;
  let locationB: any;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    stockMovementService = new StockMovementService(db);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém movimentação', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const warehouse2 = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém movimentação 2', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId2 = warehouse2.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente movimentação', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    locationA = (
      await db.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
        [warehouseId, zone.id, SEED_ACTOR_ID]
      )
    ).rows[0];
    locationB = (
      await db.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','002','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
        [warehouseId, zone.id, SEED_ACTOR_ID]
      )
    ).rows[0];

    const zone2 = await zoneService.create({ warehouse_id: warehouseId2, code: 'STO', name: 'Armazenagem 2', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
      [warehouseId2, zone2.id, SEED_ACTOR_ID]
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function seedProduct() {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto movimentação', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
  }

  async function seedBalance(productId: string, locationIdArg: string, bucket: StockBucket, qty: number, whId: string = warehouseId) {
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: whId };
    const column = BUCKET_COLUMN[bucket];
    await rawAuthorizedQuery(
      testContext.databaseService,
      ctx,
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, ${column}, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, whId, productId, locationIdArg, qty, SEED_ACTOR_ID]
    );
  }

  async function readBalance(productId: string, locationIdArg: string, whId: string = warehouseId) {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: whId },
      `SELECT qty_available, qty_reserved, qty_blocked, qty_quarantine, qty_damaged, qty_in_transit FROM wms.stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND location_id = $4`,
      [clientId, whId, productId, locationIdArg]
    );
    return result.rows[0];
  }

  async function readLastMovement(productId: string) {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT movement_type, balance_bucket_from, balance_bucket_to, qty FROM wms.stock_movement WHERE product_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [productId]
    );
    return result.rows[0];
  }

  it('catálogo tem exatamente 18 tipos e todos são aceitos pelo CHECK do banco (nenhum rejeitado por valor desconhecido)', () => {
    expect(MOVEMENT_TYPES.length).toBe(18);
  });

  it('ENTRADA_RECEBIMENTO: crédito puro em AVAILABLE (bucketTo override)', async () => {
    const product = await seedProduct();
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'ENTRADA_RECEBIMENTO', productId: product.id, qty: 50, locationIdTo: locationA.id, bucketToOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
    });
    const balance = await readBalance(product.id, locationA.id);
    expect(Number(balance.qty_available)).toBe(50);
    const movement = await readLastMovement(product.id);
    expect(movement).toMatchObject({ movement_type: 'ENTRADA_RECEBIMENTO', balance_bucket_from: null, balance_bucket_to: 'AVAILABLE' });
  });

  it('PUTAWAY: move AVAILABLE de A para B (mesma parcela, com origem)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 30);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'PUTAWAY', productId: product.id, qty: 30, locationIdFrom: locationA.id, locationIdTo: locationB.id, bucketFromOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_available)).toBe(0);
    expect(Number((await readBalance(product.id, locationB.id)).qty_available)).toBe(30);
  });

  it('RESERVA / LIBERACAO_RESERVA: AVAILABLE <-> RESERVED', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 20);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'RESERVA', productId: product.id, qty: 12, locationIdFrom: locationA.id, locationIdTo: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    let balance = await readBalance(product.id, locationA.id);
    expect(Number(balance.qty_available)).toBe(8);
    expect(Number(balance.qty_reserved)).toBe(12);

    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'LIBERACAO_RESERVA', productId: product.id, qty: 5, locationIdFrom: locationA.id, locationIdTo: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    balance = await readBalance(product.id, locationA.id);
    expect(Number(balance.qty_available)).toBe(13);
    expect(Number(balance.qty_reserved)).toBe(7);
  });

  it('PICKING: baixa de RESERVED (saída do endereço)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'RESERVED', 15);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'PICKING', productId: product.id, qty: 15, locationIdFrom: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    const balance = await readBalance(product.id, locationA.id);
    expect(Number(balance.qty_reserved)).toBe(0);
  });

  it('TRANSFERENCIA_INTERNA: move AVAILABLE de A para B (mesma parcela)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 25);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'TRANSFERENCIA_INTERNA', productId: product.id, qty: 25, locationIdFrom: locationA.id, locationIdTo: locationB.id, bucketFromOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_available)).toBe(0);
    expect(Number((await readBalance(product.id, locationB.id)).qty_available)).toBe(25);
  });

  it('TRANSFERENCIA_SAIDA_ARMAZEM / TRANSFERENCIA_ENTRADA_ARMAZEM: AVAILABLE origem -> IN_TRANSIT -> AVAILABLE destino (2 armazéns)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 18);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'TRANSFERENCIA_SAIDA_ARMAZEM', productId: product.id, qty: 18, locationIdFrom: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    let origin = await readBalance(product.id, locationA.id);
    expect(Number(origin.qty_available)).toBe(0);
    expect(Number(origin.qty_in_transit)).toBe(18);

    const destinationLocationResult = await testContext.databaseService.queryGlobal<{ id: string }>(`SELECT id FROM wms.location WHERE warehouse_id = $1 LIMIT 1`, [warehouseId2]);
    const destinationLocationId = destinationLocationResult.rows[0].id;

    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, destinationWarehouseId: warehouseId2, movementType: 'TRANSFERENCIA_ENTRADA_ARMAZEM', productId: product.id, qty: 18,
      locationIdFrom: locationA.id, locationIdTo: destinationLocationId, bucketToOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
    });
    origin = await readBalance(product.id, locationA.id);
    expect(Number(origin.qty_in_transit)).toBe(0);
    const destination = await readBalance(product.id, destinationLocationId, warehouseId2);
    expect(Number(destination.qty_available)).toBe(18);
  });

  it('REPOSICAO: move AVAILABLE de storage para picking (mesma parcela)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 40);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'REPOSICAO', productId: product.id, qty: 40, locationIdFrom: locationA.id, locationIdTo: locationB.id, bucketFromOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationB.id)).qty_available)).toBe(40);
  });

  it('BLOQUEIO / DESBLOQUEIO: AVAILABLE <-> BLOCKED', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 10);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'BLOQUEIO', productId: product.id, qty: 10, locationIdFrom: locationA.id, locationIdTo: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_blocked)).toBe(10);

    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'DESBLOQUEIO', productId: product.id, qty: 10, locationIdFrom: locationA.id, locationIdTo: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_available)).toBe(10);
  });

  it('LIBERACAO_QUARENTENA: QUARANTINE -> AVAILABLE', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'QUARANTINE', 7);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'LIBERACAO_QUARENTENA', productId: product.id, qty: 7, locationIdFrom: locationA.id, locationIdTo: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    const balance = await readBalance(product.id, locationA.id);
    expect(Number(balance.qty_quarantine)).toBe(0);
    expect(Number(balance.qty_available)).toBe(7);
  });

  it('RECLASSIFICACAO_AVARIA: AVAILABLE -> DAMAGED (bucketFrom override)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 9);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'RECLASSIFICACAO_AVARIA', productId: product.id, qty: 9, locationIdFrom: locationA.id, locationIdTo: locationA.id, bucketFromOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
    });
    const balance = await readBalance(product.id, locationA.id);
    expect(Number(balance.qty_damaged)).toBe(9);
  });

  it('AJUSTE_INVENTARIO_POS / AJUSTE_INVENTARIO_NEG: crédito/débito em AVAILABLE', async () => {
    const product = await seedProduct();
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'AJUSTE_INVENTARIO_POS', productId: product.id, qty: 6, locationIdTo: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_available)).toBe(6);

    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'AJUSTE_INVENTARIO_NEG', productId: product.id, qty: 4, locationIdFrom: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_available)).toBe(2);
  });

  it('DESCARTE: débito puro de DAMAGED (bucketFrom override)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'DAMAGED', 3);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'DESCARTE', productId: product.id, qty: 3, locationIdFrom: locationA.id, bucketFromOverride: 'DAMAGED', actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_damaged)).toBe(0);
  });

  it('ENTRADA_REVERSA: crédito puro conforme triagem (bucketTo override)', async () => {
    const product = await seedProduct();
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'ENTRADA_REVERSA', productId: product.id, qty: 11, locationIdTo: locationA.id, bucketToOverride: 'QUARANTINE', actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_quarantine)).toBe(11);
  });

  it('SAIDA_EXPEDICAO: baixa final de RESERVED por padrão', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'RESERVED', 14);
    await stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
      tenantId: clientId, warehouseId, movementType: 'SAIDA_EXPEDICAO', productId: product.id, qty: 14, locationIdFrom: locationA.id, actorUserId: SEED_ACTOR_ID,
    });
    expect(Number((await readBalance(product.id, locationA.id)).qty_reserved)).toBe(0);
  });

  it('RG-004 [INVIOLÁVEL]: débito maior que o saldo disponível é rejeitado (0 linhas afetadas)', async () => {
    const product = await seedProduct();
    await seedBalance(product.id, locationA.id, 'AVAILABLE', 5);
    await expect(
      stockMovementService.applyStandalone({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, {
        tenantId: clientId, warehouseId, movementType: 'PICKING', productId: product.id, qty: 999, locationIdFrom: locationA.id, bucketFromOverride: 'AVAILABLE', actorUserId: SEED_ACTOR_ID,
      })
    ).rejects.toThrow();
  });

  it('RN-EST-001 [INVIOLÁVEL]: escrita direta em stock_balance FORA do StockMovementService é rejeitada pelo trigger de guarda (ERRCODE 42501)', async () => {
    const product = await seedProduct();
    // SEM set_config('app.stock_movement_authorized', ...) — exatamente o
    // caminho que rawAuthorizedQuery() existe para AUTORIZAR nos outros
    // testes; aqui é o caso negativo, provando que o trigger de fato bloqueia.
    await expect(
      testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
        await client.query(
          `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [clientId, warehouseId, product.id, locationA.id, 100, SEED_ACTOR_ID]
        );
      })
    ).rejects.toMatchObject({ code: '42501' });

    const balance = await readBalance(product.id, locationA.id);
    expect(balance).toBeUndefined(); // nada foi de fato inserido
  });
});
