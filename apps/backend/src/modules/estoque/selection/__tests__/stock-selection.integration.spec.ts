// DOC-05 §4.2 — Seleção de Saldo contra Postgres real.
// RN-EST-010 (universo de candidatos), RN-EST-011 (ordenação por política,
// incluindo a derivação REAL da "data de entrada do saldo" a partir do
// primeiro stock_movement de entrada) e RN-EST-012 (shelf life mínimo).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { ZoneService } from '../../../cadastro/zone/zone.service.js';
import { BatchService } from '../../../cadastro/batch/batch.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { StockSelectionService } from '../stock-selection.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';

describe('Estoque - DOC-05 §4.2 RN-EST-010/011/012 Seleção de Saldo', () => {
  let testContext: TestContext;
  let selectionService: StockSelectionService;
  let productService: ProductService;
  let batchService: BatchService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;
  let pickingZoneId: string;
  let crossDockZoneId: string;
  let driveInEquipmentId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    selectionService = new StockSelectionService(db);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    batchService = new BatchService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém seleção', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente seleção', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    // RG-006: política padrão do cliente×armazém (usada quando product.giro_policy é nula).
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;
    pickingZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'PIK', name: 'Picking', zone_type: 'PICKING' }, SEED_ACTOR_ID)).id;
    crossDockZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'XDK', name: 'Cross-dock', zone_type: 'CROSS_DOCKING' }, SEED_ACTOR_ID)).id;

    const equipment = await db.queryGlobal(
      `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by) VALUES ($1,'DRV','DRIVE_IN',$2) RETURNING id`,
      [warehouseId, SEED_ACTOR_ID]
    );
    driveInEquipmentId = equipment.rows[0].id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  let locationSeq = 0;
  async function createLocation(opts: {
    zoneId: string;
    locationType: string;
    status?: string;
    equipmentId?: string | null;
    aisle?: string;
    module?: string;
    level?: string;
    slot?: string;
  }) {
    locationSeq += 1;
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, storage_equipment_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,5000,100,5,5,$9,$10) RETURNING *`,
      [
        warehouseId,
        opts.zoneId,
        opts.equipmentId ?? null,
        opts.aisle ?? 'A1',
        opts.module ?? String(locationSeq).padStart(3, '0'),
        opts.level ?? '00',
        opts.slot ?? '01',
        opts.locationType,
        opts.status ?? 'ACTIVE',
        SEED_ACTOR_ID,
      ]
    );
    return result.rows[0];
  }

  async function createProduct(overrides: Partial<{ giro_policy: string; shelf_life_days: number; min_shelf_life_pct: number }> = {}) {
    return productService.create(
      {
        tenant_id: clientId,
        sku: randomSku(),
        description: 'Produto seleção',
        species_code: 'GERAL',
        base_uom: 'UN',
        gross_weight_kg: 1,
        length_m: 0.1,
        width_m: 0.1,
        height_m: 0.1,
        ...overrides,
      },
      SEED_ACTOR_ID
    );
  }

  /**
   * Cria saldo COM a data de entrada real: insere o stock_balance e o
   * stock_movement de ENTRADA correspondente, com `occurred_at` explícito —
   * é dele que a seleção deriva a "data de entrada do saldo" (RN-EST-011).
   */
  async function seedBalance(opts: {
    productId: string;
    locationId: string;
    qtyAvailable?: number;
    batchId?: string | null;
    palletId?: string | null;
    entryAt?: string;
    bucket?: 'AVAILABLE' | 'BLOCKED' | 'QUARANTINE' | 'DAMAGED' | 'RESERVED' | 'IN_TRANSIT';
  }) {
    const bucket = opts.bucket ?? 'AVAILABLE';
    const column = {
      AVAILABLE: 'qty_available',
      BLOCKED: 'qty_blocked',
      QUARANTINE: 'qty_quarantine',
      DAMAGED: 'qty_damaged',
      RESERVED: 'qty_reserved',
      IN_TRANSIT: 'qty_in_transit',
    }[bucket];
    const qty = opts.qtyAvailable ?? 100;
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };

    const inserted = await rawAuthorizedQuery<{ id: string }>(
      testContext.databaseService,
      ctx,
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id, ${column}, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [clientId, warehouseId, opts.productId, opts.batchId ?? null, opts.locationId, opts.palletId ?? null, qty, SEED_ACTOR_ID]
    );

    if (opts.entryAt) {
      const entryDate = new Date(opts.entryAt);
      await testContext.databaseService.queryGlobal(`SELECT wms.ensure_stock_movement_partition($1, $2)`, [entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1]);
      await testContext.databaseService.query(
        ctx,
        `INSERT INTO wms.stock_movement (tenant_id, warehouse_id, movement_type, product_id, batch_id,
                                         location_id_to, pallet_id_to, balance_bucket_to, qty, occurred_at, created_by)
         VALUES ($1,$2,'ENTRADA_RECEBIMENTO',$3,$4,$5,$6,'AVAILABLE',$7,$8,$9)`,
        [clientId, warehouseId, opts.productId, opts.batchId ?? null, opts.locationId, opts.palletId ?? null, qty, opts.entryAt, SEED_ACTOR_ID]
      );
    }

    return inserted.rows[0].id;
  }

  async function createBatch(productId: string, expirationDate: string | null, status = 'RELEASED') {
    const batch = await batchService.create(
      { tenant_id: clientId, product_id: productId, batch_code: `L-${Math.random().toString(36).slice(2, 10)}`, expiration_date: expirationDate ?? undefined },
      SEED_ACTOR_ID
    );
    if (status !== 'RELEASED') {
      await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `UPDATE wms.batch SET status = $2 WHERE id = $1`, [
        batch.id,
        status,
      ]);
    }
    return batch;
  }

  function select(productId: string, demandQty: number, extra: Record<string, unknown> = {}) {
    return selectionService.select({
      tenantId: clientId,
      warehouseId,
      productId,
      demandQty,
      purpose: 'CLIENT_DISPATCH',
      actorUserId: SEED_ACTOR_ID,
      ...extra,
    } as any);
  }

  // ───────────────────────────────────────────────────────────────────────
  // §6 — Cenário: "Seleção FEFO com desempates (exemplo normativo RN-EST-011)"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 EXEMPLO NORMATIVO: demanda 150 → 80 de S1 + 70 de S2; S3 intocado', async () => {
    const product = await createProduct({ giro_policy: 'FEFO' });
    const pickingLocation = await createLocation({ zoneId: pickingZoneId, locationType: 'PICKING', aisle: 'P1' });
    const storageLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', aisle: 'A1' });
    const pickingLocation2 = await createLocation({ zoneId: pickingZoneId, locationType: 'PICKING', aisle: 'P2' });

    const l1 = await createBatch(product.id, '2026-09-01');
    const l2 = await createBatch(product.id, '2026-09-01');
    const l3 = await createBatch(product.id, '2026-10-15');

    const s1 = await seedBalance({ productId: product.id, locationId: pickingLocation.id, batchId: l1.id, qtyAvailable: 80, entryAt: '2026-08-01T00:00:00.000Z' });
    const s2 = await seedBalance({ productId: product.id, locationId: storageLocation.id, batchId: l2.id, qtyAvailable: 100, entryAt: '2026-08-01T00:00:00.000Z' });
    const s3 = await seedBalance({ productId: product.id, locationId: pickingLocation2.id, batchId: l3.id, qtyAvailable: 200, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 150);

    expect(outcome.policy).toBe('FEFO');
    expect(outcome.allocations.map((a) => [a.candidate.stockBalanceId, a.qtyAllocated])).toEqual([
      [s1, 80],
      [s2, 70],
    ]);
    expect(outcome.shortfall).toBe(0);
    expect(outcome.allocations.some((a) => a.candidate.stockBalanceId === s3)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — Cenário: "Shelf life mínimo exclui lote (exemplo normativo RN-EST-012)"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 EXEMPLO NORMATIVO: shelf_life 365d, mínimo 30%, hoje 2026-08-10 — lote 2026-11-10 excluído, 2027-01-10 elegível', async () => {
    const product = await createProduct({ giro_policy: 'FEFO', shelf_life_days: 365, min_shelf_life_pct: 30 });
    const location = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });

    const batchA = await createBatch(product.id, '2026-11-10'); // 92 dias = 25,2% → excluído
    const batchB = await createBatch(product.id, '2027-01-10'); // 153 dias = 41,9% → elegível
    const balanceA = await seedBalance({ productId: product.id, locationId: location.id, batchId: batchA.id, qtyAvailable: 50, entryAt: '2026-08-01T00:00:00.000Z' });
    const balanceB = await seedBalance({ productId: product.id, locationId: location.id, batchId: batchB.id, qtyAvailable: 50, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 50, { today: '2026-08-10' });

    // Lote A não entra no universo, mesmo tendo a validade mais curta (FEFO o
    // colocaria em primeiro se fosse elegível) — a exclusão é do UNIVERSO.
    expect(outcome.excludedByShelfLife.map((e) => e.stockBalanceId)).toEqual([balanceA]);
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([balanceB]);

    // Contraprova: a MESMA demanda como movimentação interna não aplica
    // RN-EST-012 (só incide sobre expedição a cliente) — lote A volta e, por
    // FEFO, sai primeiro.
    const internal = await select(product.id, 50, { today: '2026-08-10', purpose: 'INTERNAL_REPLENISHMENT' });
    expect(internal.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([balanceA]);
    expect(internal.excludedByShelfLife).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EST-011 — FIFO / LIFO / JIT
  // ───────────────────────────────────────────────────────────────────────
  it('FIFO: menor data de entrada primeiro (derivada do primeiro stock_movement de entrada)', async () => {
    const product = await createProduct({ giro_policy: 'FIFO' });
    const location = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });

    // Lote NOVO com validade CURTA entrou primeiro; lote antigo com validade
    // longa entrou depois. Em FIFO a entrada manda — a validade é só desempate.
    const batchEarly = await createBatch(product.id, '2027-12-31');
    const batchLate = await createBatch(product.id, '2026-09-01');
    const early = await seedBalance({ productId: product.id, locationId: location.id, batchId: batchEarly.id, qtyAvailable: 10, entryAt: '2026-08-02T00:00:00.000Z' });
    const late = await seedBalance({ productId: product.id, locationId: location.id, batchId: batchLate.id, qtyAvailable: 10, entryAt: '2026-08-20T00:00:00.000Z' });

    const outcome = await select(product.id, 20);
    expect(outcome.policy).toBe('FIFO');
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([early, late]);

    // Contraprova FEFO: a ordem se inverte (validade manda).
    await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `UPDATE wms.product SET giro_policy = 'FEFO' WHERE id = $1`, [
      product.id,
    ]);
    const fefo = await select(product.id, 20);
    expect(fefo.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([late, early]);
  });

  it('LIFO: maior data de entrada primeiro', async () => {
    const product = await createProduct({ giro_policy: 'LIFO' });
    // Endereços distintos: sem lote, dois saldos no MESMO endereço colidiriam
    // na UNIQUE NULLS NOT DISTINCT de stock_balance (corrigida na 5A) — é
    // exatamente uma linha por combinação (RG-004).
    const oldLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });
    const newLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });

    const oldBalance = await seedBalance({ productId: product.id, locationId: oldLocation.id, qtyAvailable: 10, entryAt: '2026-08-02T00:00:00.000Z' });
    const newBalance = await seedBalance({ productId: product.id, locationId: newLocation.id, qtyAvailable: 10, entryAt: '2026-08-25T00:00:00.000Z' });

    const outcome = await select(product.id, 20);
    expect(outcome.policy).toBe('LIFO');
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([newBalance, oldBalance]);
  });

  it('JIT: saldo em zona CROSS_DOCKING primeiro, depois FIFO', async () => {
    const product = await createProduct({ giro_policy: 'JIT' });
    const crossDockLocation = await createLocation({ zoneId: crossDockZoneId, locationType: 'CROSS_DOCK', aisle: 'X1' });
    const storageLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', aisle: 'A1' });

    // O saldo de armazenagem entrou MUITO antes — em FIFO puro sairia
    // primeiro; em JIT o cross-docking passa na frente.
    const storageBalance = await seedBalance({ productId: product.id, locationId: storageLocation.id, qtyAvailable: 10, entryAt: '2026-08-01T00:00:00.000Z' });
    const crossDockBalance = await seedBalance({ productId: product.id, locationId: crossDockLocation.id, qtyAvailable: 10, entryAt: '2026-08-28T00:00:00.000Z' });

    const outcome = await select(product.id, 20);
    expect(outcome.policy).toBe('JIT');
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([crossDockBalance, storageBalance]);
  });

  it('RG-006: sem giro_policy no produto, resolve pela default_giro_policy do cliente×armazém', async () => {
    const product = await createProduct(); // sem giro_policy
    const location = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });
    await seedBalance({ productId: product.id, locationId: location.id, qtyAvailable: 5, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 5);
    expect(outcome.policy).toBe('FIFO'); // default do client_warehouse_settings
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EST-010 — universo de candidatos [INVIOLÁVEL]
  // ───────────────────────────────────────────────────────────────────────
  it('RN-EST-010: parcelas blocked/quarantine/damaged/reserved/in_transit NUNCA são candidatas', async () => {
    const product = await createProduct({ giro_policy: 'FIFO' });
    const location = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });

    for (const bucket of ['BLOCKED', 'QUARANTINE', 'DAMAGED', 'RESERVED', 'IN_TRANSIT'] as const) {
      const loc = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });
      await seedBalance({ productId: product.id, locationId: loc.id, qtyAvailable: 999, bucket });
    }
    const availableBalance = await seedBalance({ productId: product.id, locationId: location.id, qtyAvailable: 7, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 999);
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([availableBalance]);
    expect(outcome.shortfall).toBe(992); // só as 7 disponíveis foram alocadas
  });

  it('RN-EST-010/RN-EST-061: endereço em INVENTORY (congelado) sai do universo; BLOCKED e INACTIVE também', async () => {
    const product = await createProduct({ giro_policy: 'FIFO' });
    const inventoryLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', status: 'INVENTORY' });
    const blockedLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', status: 'BLOCKED' });
    const inactiveLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', status: 'INACTIVE' });
    const activeLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', status: 'ACTIVE' });

    await seedBalance({ productId: product.id, locationId: inventoryLocation.id, qtyAvailable: 100, entryAt: '2026-08-01T00:00:00.000Z' });
    await seedBalance({ productId: product.id, locationId: blockedLocation.id, qtyAvailable: 100, entryAt: '2026-08-01T00:00:00.000Z' });
    await seedBalance({ productId: product.id, locationId: inactiveLocation.id, qtyAvailable: 100, entryAt: '2026-08-01T00:00:00.000Z' });
    const activeBalance = await seedBalance({ productId: product.id, locationId: activeLocation.id, qtyAvailable: 10, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 400);
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([activeBalance]);
  });

  it('RN-EST-010: lote não-RELEASED (QUARANTINE/BLOCKED/RECALLED) sai do universo', async () => {
    const product = await createProduct({ giro_policy: 'FIFO' });
    const location = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });

    const quarantineBatch = await createBatch(product.id, '2027-01-01', 'QUARANTINE');
    const recalledBatch = await createBatch(product.id, '2027-01-01', 'RECALLED');
    const releasedBatch = await createBatch(product.id, '2027-01-01', 'RELEASED');

    await seedBalance({ productId: product.id, locationId: location.id, batchId: quarantineBatch.id, qtyAvailable: 100, entryAt: '2026-08-01T00:00:00.000Z' });
    await seedBalance({ productId: product.id, locationId: location.id, batchId: recalledBatch.id, qtyAvailable: 100, entryAt: '2026-08-01T00:00:00.000Z' });
    const releasedBalance = await seedBalance({ productId: product.id, locationId: location.id, batchId: releasedBatch.id, qtyAvailable: 10, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 300);
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([releasedBalance]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EST-011 / RN-DAD-010 — LIFO_PHYSICAL
  // ───────────────────────────────────────────────────────────────────────
  it('LIFO_PHYSICAL: em canal drive-in só o último a entrar é candidato (palete acessível)', async () => {
    const product = await createProduct({ giro_policy: 'FIFO' });
    // MESMO canal físico: mesmo equipamento + rua + módulo + nível; vãos distintos.
    const slotA = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', equipmentId: driveInEquipmentId, aisle: 'D1', module: '900', level: '00', slot: '01' });
    const slotB = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', equipmentId: driveInEquipmentId, aisle: 'D1', module: '900', level: '00', slot: '02' });
    // Canal DIFERENTE (outro nível) — independente.
    const otherChannel = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE', equipmentId: driveInEquipmentId, aisle: 'D1', module: '900', level: '01', slot: '01' });

    const deepBalance = await seedBalance({ productId: product.id, locationId: slotA.id, qtyAvailable: 50, entryAt: '2026-08-01T00:00:00.000Z' });
    const frontBalance = await seedBalance({ productId: product.id, locationId: slotB.id, qtyAvailable: 50, entryAt: '2026-08-20T00:00:00.000Z' });
    const otherChannelBalance = await seedBalance({ productId: product.id, locationId: otherChannel.id, qtyAvailable: 50, entryAt: '2026-08-05T00:00:00.000Z' });

    const outcome = await select(product.id, 200);

    const selectedIds = outcome.allocations.map((a) => a.candidate.stockBalanceId);
    // O saldo do FUNDO do canal (entrou primeiro) não é alcançável, apesar de
    // ser o mais antigo — que é justamente o que o FIFO pediria.
    expect(selectedIds).not.toContain(deepBalance);
    expect(selectedIds).toContain(frontBalance);
    // Canal vizinho tem seu próprio "último a entrar" e continua disponível.
    expect(selectedIds).toContain(otherChannelBalance);
  });

  // ───────────────────────────────────────────────────────────────────────
  // RG-015 — contenção de Armazém Lógico
  // ───────────────────────────────────────────────────────────────────────
  it('RG-015: endereço vinculado ao Armazém Lógico de OUTRO cliente nunca é candidato', async () => {
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const clientService = new ClientService(db, auditService);

    const otherClient = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente B', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);

    const product = await createProduct({ giro_policy: 'FIFO' });
    const freeLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });
    const otherTenantLocation = await createLocation({ zoneId: storageZoneId, locationType: 'STORAGE' });

    // Armazém Lógico do cliente B, com o endereço vinculado a ele.
    // Fixture criada NO CONTEXTO DO CLIENTE B (a RLS exige tenant_id =
    // current_setting para o INSERT). Esta suíte consulta como cliente A —
    // que é justamente quem NÃO pode enxergar o vínculo do B. É essa
    // invisibilidade que torna a leitura cross-tenant via SECURITY DEFINER
    // obrigatória na seleção: sem ela, a contenção seria um no-op silencioso.
    const otherCtx = { tenant_id: otherClient.id, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const logicalWarehouse = await db.query(
      otherCtx,
      `INSERT INTO wms.logical_warehouse (tenant_id, warehouse_id, code, name, status, created_by) VALUES ($1,$2,'LWB','Logico B','ACTIVE',$3) RETURNING id`,
      [otherClient.id, warehouseId, SEED_ACTOR_ID]
    );
    await db.query(
      otherCtx,
      `INSERT INTO wms.logical_warehouse_location (tenant_id, logical_warehouse_id, location_id, linked_by, created_by) VALUES ($1,$2,$3,$4,$4)`,
      [otherClient.id, logicalWarehouse.rows[0].id, otherTenantLocation.id, SEED_ACTOR_ID]
    );

    // Saldo do cliente A (o tenant desta suíte) nos dois endereços.
    const freeBalance = await seedBalance({ productId: product.id, locationId: freeLocation.id, qtyAvailable: 10, entryAt: '2026-08-01T00:00:00.000Z' });
    await seedBalance({ productId: product.id, locationId: otherTenantLocation.id, qtyAvailable: 10, entryAt: '2026-08-01T00:00:00.000Z' });

    const outcome = await select(product.id, 100);
    expect(outcome.allocations.map((a) => a.candidate.stockBalanceId)).toEqual([freeBalance]);
  });
});
