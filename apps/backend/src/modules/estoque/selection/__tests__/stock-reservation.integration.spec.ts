// DOC-05 §4.2 — Reserva a partir da Seleção de Saldo.
// RN-EST-013 (quebra de política com aprovação PRÉVIA), concorrência sobre o
// mesmo saldo (RG-004) e RF-EST-041 (kanban consumindo a política de giro
// real, fechando o débito da 5A).
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { ZoneService } from '../../../cadastro/zone/zone.service.js';
import { BatchService } from '../../../cadastro/batch/batch.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { RbacService } from '../../../../core/rbac/rbac.service.js';
import { ApprovalAuthorityService } from '../../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../../core/workflow/operational-exception.service.js';
import { PasswordService } from '../../../../core/auth/password.service.js';
import { StockMovementService } from '../../movement/stock-movement.service.js';
import { StockSelectionService } from '../stock-selection.service.js';
import { StockReservationService } from '../stock-reservation.service.js';
import { ReplenishmentTaskService } from '../../replenishment/replenishment-task.service.js';
import { KanbanService } from '../../replenishment/kanban.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../../core/__tests__/security-test-helpers.js';

describe('Estoque - DOC-05 §4.2 RN-EST-013 quebra de política, concorrência e kanban com política real', () => {
  let testContext: TestContext;
  let reservationService: StockReservationService;
  let selectionService: StockSelectionService;
  let kanbanService: KanbanService;
  let exceptionService: OperationalExceptionService;
  let productService: ProductService;
  let batchService: BatchService;
  let passwordService: PasswordService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;
  let pickingZoneId: string;
  /** GESTOR_ARMAZEM — detém EST.QUEBRA_POLITICA_GIRO (migration 0016). */
  let gestor: { id: string };
  /** OPERADOR_PICKING — NÃO detém EST.QUEBRA_POLITICA_GIRO. */
  let operador: { id: string };
  let aprovador: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    exceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const stockMovementService = new StockMovementService(db);
    selectionService = new StockSelectionService(db);
    reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);

    const replenishmentTaskService = new ReplenishmentTaskService(db, eventsService, auditService, stockMovementService);
    kanbanService = new KanbanService(db, eventsService, replenishmentTaskService, selectionService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    batchService = new BatchService(db, auditService);
    passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém reserva', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente reserva', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FEFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;
    pickingZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'PIK', name: 'Picking', zone_type: 'PICKING' }, SEED_ACTOR_ID)).id;

    gestor = await createTestUser(db, passwordService);
    operador = await createTestUser(db, passwordService);
    aprovador = await createTestUser(db, passwordService);
    await assignRole(db, { userId: gestor.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    await assignRole(db, { userId: operador.id, roleCode: 'OPERADOR_PICKING', warehouseId, clientId });
    await assignRole(db, { userId: aprovador.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'EST.QUEBRA_FEFO', warehouseId, maxQty: 10000 });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  let locationSeq = 0;
  async function createLocation(zoneId: string, locationType: string) {
    locationSeq += 1;
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1',$3,'00','01',$4,5000,100,5,5,'ACTIVE',$5) RETURNING *`,
      [warehouseId, zoneId, String(locationSeq).padStart(3, '0'), locationType, SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  async function createProduct(overrides: Partial<{ giro_policy: string; shelf_life_days: number; min_shelf_life_pct: number }> = {}) {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto reserva', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, ...overrides },
      SEED_ACTOR_ID
    );
  }

  async function seedBalance(productId: string, locationId: string, qty: number, batchId: string | null, entryAt: string) {
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const inserted = await rawAuthorizedQuery<{ id: string }>(
      testContext.databaseService,
      ctx,
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, batch_id, location_id, qty_available, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [clientId, warehouseId, productId, batchId, locationId, qty, SEED_ACTOR_ID]
    );
    const entryDate = new Date(entryAt);
    await testContext.databaseService.queryGlobal(`SELECT wms.ensure_stock_movement_partition($1, $2)`, [entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1]);
    await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.stock_movement (tenant_id, warehouse_id, movement_type, product_id, batch_id, location_id_to, balance_bucket_to, qty, occurred_at, created_by)
       VALUES ($1,$2,'ENTRADA_RECEBIMENTO',$3,$4,$5,'AVAILABLE',$6,$7,$8)`,
      [clientId, warehouseId, productId, batchId, locationId, qty, entryAt, SEED_ACTOR_ID]
    );
    return inserted.rows[0].id;
  }

  async function createBatch(productId: string, expirationDate: string) {
    return batchService.create(
      { tenant_id: clientId, product_id: productId, batch_code: `L-${Math.random().toString(36).slice(2, 10)}`, expiration_date: expirationDate },
      SEED_ACTOR_ID
    );
  }

  /** Abre e APROVA uma exceção EST.QUEBRA_FEFO (1 passo, migration 0044). */
  async function approvedPolicyBreakException(qty: number, attachmentKeys: string[] = []) {
    const exception = await exceptionService.create({
      tenantId: clientId,
      exceptionType: 'EST.QUEBRA_FEFO',
      warehouseId,
      entity: 'stock_reservation',
      entityId: '00000000-0000-0000-0000-0000000000ff',
      qty,
      reasonRequest: 'Cliente exige lote específico',
      requestedBy: gestor.id,
    });
    if (attachmentKeys.length > 0) {
      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `UPDATE wms.operational_exception SET attachment_keys = $2 WHERE id = $1`,
        [exception.id, attachmentKeys]
      );
    }
    await exceptionService.decide(exception.id, clientId, warehouseId, aprovador.id, 'APPROVE', 'Autorizado pelo cliente');
    return exception;
  }

  async function readBalance(balanceId: string) {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE id = $1`,
      [balanceId]
    );
    return result.rows[0];
  }

  // ───────────────────────────────────────────────────────────────────────
  // Entregável 6 — reserva a partir da seleção
  // ───────────────────────────────────────────────────────────────────────
  it('reserva converte a lista de alocações em movimentações RESERVA e persiste o detalhamento saldo→demanda', async () => {
    const product = await createProduct({ giro_policy: 'FEFO' });
    const locationA = await createLocation(storageZoneId, 'STORAGE');
    const locationB = await createLocation(storageZoneId, 'STORAGE');
    const shortBatch = await createBatch(product.id, '2026-09-01');
    const longBatch = await createBatch(product.id, '2027-09-01');

    const balanceShort = await seedBalance(product.id, locationA.id, 80, shortBatch.id, '2026-08-01T00:00:00.000Z');
    const balanceLong = await seedBalance(product.id, locationB.id, 100, longBatch.id, '2026-08-01T00:00:00.000Z');

    const demandRefId = '00000000-0000-0000-0000-0000000000d1';
    const result = await reservationService.reserve({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      demandQty: 150,
      purpose: 'CLIENT_DISPATCH',
      demandRefType: 'OUTBOUND_ORDER',
      demandRefId,
      actorUserId: SEED_ACTOR_ID,
    });

    // FEFO: consome o lote de validade mais curta primeiro, depois o outro.
    expect(result.reservations.map((r) => [r.stockBalanceId, r.qty])).toEqual([
      [balanceShort, 80],
      [balanceLong, 70],
    ]);
    expect(result.qtyReserved).toBe(150);
    expect(result.shortfall).toBe(0);

    // Efeito real no saldo: available → reserved (RN-EST-001, movimento RESERVA).
    const afterShort = await readBalance(balanceShort);
    expect(Number(afterShort.qty_available)).toBe(0);
    expect(Number(afterShort.qty_reserved)).toBe(80);
    const afterLong = await readBalance(balanceLong);
    expect(Number(afterLong.qty_available)).toBe(30);
    expect(Number(afterLong.qty_reserved)).toBe(70);

    // Detalhamento persistido para o picking (DOC-06) consumir depois.
    const persisted = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT stock_balance_id, qty, status, purpose, policy_break FROM wms.stock_reservation WHERE demand_ref_id = $1 ORDER BY qty DESC`,
      [demandRefId]
    );
    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows.every((r: any) => r.status === 'ACTIVE' && r.purpose === 'CLIENT_DISPATCH' && r.policy_break === false)).toBe(true);
  });

  it('demanda maior que o disponível é erro determinístico (RG-004), sem efeito parcial', async () => {
    const product = await createProduct({ giro_policy: 'FEFO' });
    const location = await createLocation(storageZoneId, 'STORAGE');
    const balance = await seedBalance(product.id, location.id, 10, null, '2026-08-01T00:00:00.000Z');

    await expect(
      reservationService.reserve({
        tenantId: clientId,
        warehouseId,
        productId: product.id,
        demandQty: 100,
        purpose: 'CLIENT_DISPATCH',
        demandRefType: 'OUTBOUND_ORDER',
        demandRefId: '00000000-0000-0000-0000-0000000000d2',
        actorUserId: SEED_ACTOR_ID,
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    // Transação inteira revertida — nada reservado.
    const after = await readBalance(balance);
    expect(Number(after.qty_available)).toBe(10);
    expect(Number(after.qty_reserved)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — Cenário: "Quebra de FEFO exige aprovação prévia"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RN-EST-013: reserva de lote fora da ordem só efetiva após exceção EST.QUEBRA_FEFO APROVADA', async () => {
    const product = await createProduct({ giro_policy: 'FEFO' });
    const locationA = await createLocation(storageZoneId, 'STORAGE');
    const locationB = await createLocation(storageZoneId, 'STORAGE');
    const firstInOrder = await createBatch(product.id, '2026-09-01'); // FEFO escolheria este
    const l9 = await createBatch(product.id, '2027-09-01'); // lote exigido pelo cliente

    await seedBalance(product.id, locationA.id, 50, firstInOrder.id, '2026-08-01T00:00:00.000Z');
    const balanceL9 = await seedBalance(product.id, locationB.id, 50, l9.id, '2026-08-01T00:00:00.000Z');

    const baseInput = {
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      demandQty: 10,
      purpose: 'CLIENT_DISPATCH' as const,
      demandRefType: 'OUTBOUND_ORDER',
      demandRefId: '00000000-0000-0000-0000-0000000000d3',
      forcedBatchId: l9.id,
      breakReason: 'Cliente exige o lote L9',
      actorUserId: gestor.id,
    };

    // (a) sem exceção nenhuma → rejeitado.
    await expect(reservationService.reserve({ ...baseInput })).rejects.toBeInstanceOf(BadRequestException);

    // (b) com exceção PENDENTE (ainda não aprovada) → rejeitado. A aprovação
    // precisa ser ANTERIOR à reserva; aprovar depois não regulariza.
    const pending = await exceptionService.create({
      tenantId: clientId,
      exceptionType: 'EST.QUEBRA_FEFO',
      warehouseId,
      entity: 'stock_reservation',
      entityId: '00000000-0000-0000-0000-0000000000fe',
      qty: 10,
      reasonRequest: 'Cliente exige lote específico',
      requestedBy: gestor.id,
    });
    await expect(reservationService.reserve({ ...baseInput, policyBreakExceptionId: pending.id })).rejects.toBeInstanceOf(ConflictException);

    // (c) exceção APROVADA, mas usuário SEM EST.QUEBRA_POLITICA_GIRO → negado.
    const approved = await approvedPolicyBreakException(10);
    await expect(reservationService.reserve({ ...baseInput, policyBreakExceptionId: approved.id, actorUserId: operador.id })).rejects.toBeInstanceOf(ForbiddenException);

    // (d) permissão + exceção aprovada → efetiva, no lote EXIGIDO (não no FEFO).
    const result = await reservationService.reserve({ ...baseInput, policyBreakExceptionId: approved.id });
    expect(result.reservations.map((r) => r.stockBalanceId)).toEqual([balanceL9]);

    // RD-EST-005: a movimentação resultante é marcada policy_break com motivo.
    const movement = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT movement_type, policy_break, break_reason FROM wms.stock_movement WHERE id = $1`,
      [result.reservations[0].movementId]
    );
    expect(movement.rows[0]).toMatchObject({ movement_type: 'RESERVA', policy_break: true, break_reason: 'Cliente exige o lote L9' });

    const reservation = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT policy_break, break_reason, policy_break_exception_id FROM wms.stock_reservation WHERE id = $1`,
      [result.reservations[0].id]
    );
    expect(reservation.rows[0].policy_break).toBe(true);
    expect(reservation.rows[0].policy_break_exception_id).toBe(approved.id);
  });

  it('RN-EST-013: quebra por SHELF LIFE exige anexo de autorização do cliente na exceção', async () => {
    const product = await createProduct({ giro_policy: 'FEFO', shelf_life_days: 365, min_shelf_life_pct: 30 });
    const location = await createLocation(storageZoneId, 'STORAGE');
    // 92 dias restantes em 2026-08-10 = 25,2% → reprovado por RN-EST-012.
    const shortShelfBatch = await createBatch(product.id, '2026-11-10');
    const balance = await seedBalance(product.id, location.id, 40, shortShelfBatch.id, '2026-08-01T00:00:00.000Z');

    const baseInput = {
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      demandQty: 10,
      purpose: 'CLIENT_DISPATCH' as const,
      demandRefType: 'OUTBOUND_ORDER',
      demandRefId: '00000000-0000-0000-0000-0000000000d4',
      today: '2026-08-10',
      overrideShelfLife: true,
      breakReason: 'Cliente autorizou vida útil abaixo do mínimo',
      actorUserId: gestor.id,
    };

    // Exceção aprovada, porém SEM anexo → rejeitado.
    const withoutAttachment = await approvedPolicyBreakException(10);
    await expect(reservationService.reserve({ ...baseInput, policyBreakExceptionId: withoutAttachment.id })).rejects.toBeInstanceOf(BadRequestException);

    // Com anexo registrado → efetiva.
    const withAttachment = await approvedPolicyBreakException(10, ['s3://autorizacoes/cliente-shelf-life.pdf']);
    const result = await reservationService.reserve({ ...baseInput, policyBreakExceptionId: withAttachment.id });
    expect(result.reservations.map((r) => r.stockBalanceId)).toEqual([balance]);
    expect(result.selection.shelfLifeOverridden).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Concorrência (RG-004)
  // ───────────────────────────────────────────────────────────────────────
  it('duas reservas simultâneas de 60 sobre saldo de 100 nunca reservam 60+60', async () => {
    const product = await createProduct({ giro_policy: 'FEFO' });
    const location = await createLocation(storageZoneId, 'STORAGE');
    const balance = await seedBalance(product.id, location.id, 100, null, '2026-08-01T00:00:00.000Z');

    const reserveSixty = (demandRefId: string) =>
      reservationService.reserve({
        tenantId: clientId,
        warehouseId,
        productId: product.id,
        demandQty: 60,
        purpose: 'CLIENT_DISPATCH',
        demandRefType: 'OUTBOUND_ORDER',
        demandRefId,
        allowPartial: true, // parcial permitido: prova que a 2ª releu o saldo já debitado
        actorUserId: SEED_ACTOR_ID,
      });

    const [first, second] = await Promise.all([
      reserveSixty('00000000-0000-0000-0000-0000000000e1'),
      reserveSixty('00000000-0000-0000-0000-0000000000e2'),
    ]);

    const reservedQuantities = [first.qtyReserved, second.qtyReserved].sort((a, b) => b - a);
    expect(reservedQuantities).toEqual([60, 40]); // uma pegou 60, a outra só o que sobrou
    expect(first.qtyReserved + second.qtyReserved).toBe(100);

    // O saldo fecha exatamente: nada além do que existia foi reservado.
    const after = await readBalance(balance);
    expect(Number(after.qty_available)).toBe(0);
    expect(Number(after.qty_reserved)).toBe(100);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Entregável 5 — kanban usa a política de giro REAL (fecha o débito da 5A)
  // ───────────────────────────────────────────────────────────────────────
  it('RF-EST-041: reposição kanban escolhe a origem pela política do produto (FEFO), não pelo maior saldo', async () => {
    const product = await createProduct({ giro_policy: 'FEFO' });
    const pickingLocation = await createLocation(pickingZoneId, 'PICKING');
    const bigLongExpiry = await createLocation(storageZoneId, 'STORAGE');
    const smallShortExpiry = await createLocation(storageZoneId, 'STORAGE');

    // A heurística PROVISÓRIA da 5A escolhia o MAIOR saldo → pegaria o de
    // validade longa. O FEFO real precisa escolher o de validade CURTA.
    const longBatch = await createBatch(product.id, '2027-12-31');
    const shortBatch = await createBatch(product.id, '2026-09-15');
    await seedBalance(product.id, bigLongExpiry.id, 500, longBatch.id, '2026-08-01T00:00:00.000Z');
    await seedBalance(product.id, smallShortExpiry.id, 60, shortBatch.id, '2026-08-01T00:00:00.000Z');
    // Saldo de picking abaixo do gatilho, para o kanban disparar.
    await seedBalance(product.id, pickingLocation.id, 5, null, '2026-08-01T00:00:00.000Z');

    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_warehouse_parameter (tenant_id, product_id, warehouse_id, kanban_enabled, kanban_trigger_qty, kanban_replenish_qty, default_picking_location_id, created_by)
       VALUES ($1,$2,$3,TRUE,10,30,$4,$5)`,
      [clientId, product.id, warehouseId, pickingLocation.id, SEED_ACTOR_ID]
    );

    const result = await kanbanService.checkKanban();
    expect(result.generatedTaskIds).toHaveLength(1);

    const task = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT location_id_origin, batch_id, qty FROM wms.replenishment_task WHERE id = $1`,
      [result.generatedTaskIds[0]]
    );
    // Origem = lote de validade mais curta (FEFO), NÃO o endereço de maior saldo.
    expect(task.rows[0].location_id_origin).toBe(smallShortExpiry.id);
    expect(task.rows[0].batch_id).toBe(shortBatch.id);
    expect(Number(task.rows[0].qty)).toBe(30);
  });
});
