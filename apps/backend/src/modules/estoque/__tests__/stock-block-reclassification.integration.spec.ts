// DOC-05 §4.4 — RF-EST-030 (bloqueio/desbloqueio manual, motivo tipificado) e
// RF-EST-031 (reclassificação para avaria + descarte via exceção
// EST.DESCARTE_SALDO, 2 passos).
import { BadRequestException } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { StockBlockService } from '../blocking/stock-block.service.js';
import { StockReclassificationService } from '../blocking/stock-reclassification.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../core/__tests__/security-test-helpers.js';

describe('Estoque - DOC-05 §4.4 RF-EST-030/031 bloqueio, reclassificação e descarte', () => {
  let testContext: TestContext;
  let stockBlockService: StockBlockService;
  let stockReclassificationService: StockReclassificationService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let locationId: string;
  let passwordService: PasswordService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const stockMovementService = new StockMovementService(db);

    stockBlockService = new StockBlockService(db, stockMovementService, auditService);
    stockReclassificationService = new StockReclassificationService(db, eventsService, auditService, operationalExceptionService, stockMovementService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém bloqueio/descarte', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente bloqueio/descarte', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    const locationResult = await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING id`,
      [warehouseId, zone.id, SEED_ACTOR_ID]
    );
    locationId = locationResult.rows[0].id;
    // Concedido uma única vez para o armazém inteiro (approval_authority é
    // por role_id+exception_type+warehouse_id — repetir por teste violaria a
    // UNIQUE); reaproveitado pelos testes de descarte (2 passos) abaixo.
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'EST.DESCARTE_SALDO', warehouseId, maxQty: 100 });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function seedProductWithBalance(qtyAvailable: number) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto bloqueio/descarte', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await rawAuthorizedQuery(
      testContext.databaseService,
      ctx,
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, warehouseId, product.id, locationId, qtyAvailable, SEED_ACTOR_ID]
    );
    return product;
  }

  async function readBalance(productId: string) {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_blocked, qty_damaged FROM wms.stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND location_id = $4`,
      [clientId, warehouseId, productId, locationId]
    );
    return result.rows[0];
  }

  it('RF-EST-030: bloqueio move available -> blocked com motivo tipificado, e desbloqueio reverte', async () => {
    const product = await seedProductWithBalance(100);

    await stockBlockService.block({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      qty: 40,
      reasonCode: 'QUALIDADE',
      actorUserId: SEED_ACTOR_ID,
    });
    let balance = await readBalance(product.id);
    expect(Number(balance.qty_available)).toBe(60);
    expect(Number(balance.qty_blocked)).toBe(40);

    await stockBlockService.unblock({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      qty: 15,
      reasonCode: 'DIVERGENCIA',
      actorUserId: SEED_ACTOR_ID,
    });
    balance = await readBalance(product.id);
    expect(Number(balance.qty_available)).toBe(75);
    expect(Number(balance.qty_blocked)).toBe(25);
  });

  it('RF-EST-030: motivo OUTRO exige texto livre; motivo desconhecido é rejeitado', async () => {
    const product = await seedProductWithBalance(50);

    await expect(
      stockBlockService.block({ tenantId: clientId, warehouseId, productId: product.id, locationId, qty: 10, reasonCode: 'OUTRO', actorUserId: SEED_ACTOR_ID })
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      stockBlockService.block({ tenantId: clientId, warehouseId, productId: product.id, locationId, qty: 10, reasonCode: 'INEXISTENTE', actorUserId: SEED_ACTOR_ID })
    ).rejects.toBeInstanceOf(BadRequestException);

    // Com texto, OUTRO é aceito.
    await stockBlockService.block({ tenantId: clientId, warehouseId, productId: product.id, locationId, qty: 10, reasonCode: 'OUTRO', reasonText: 'Motivo específico do cliente', actorUserId: SEED_ACTOR_ID });
    const balance = await readBalance(product.id);
    expect(Number(balance.qty_blocked)).toBe(10);
  });

  it('RF-EST-031: reclassificação para avaria exige >= 1 foto e move available -> damaged', async () => {
    const product = await seedProductWithBalance(30);

    await expect(
      stockReclassificationService.registerAvaria({
        tenantId: clientId,
        warehouseId,
        productId: product.id,
        locationId,
        fromBucket: 'AVAILABLE',
        qty: 5,
        photoKeys: [],
        actorUserId: SEED_ACTOR_ID,
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    const { reclassification } = await stockReclassificationService.registerAvaria({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      fromBucket: 'AVAILABLE',
      qty: 5,
      photoKeys: ['s3://evidencias/avaria-1.jpg'],
      actorUserId: SEED_ACTOR_ID,
    });
    expect(reclassification.status).toBe('RESOLVED');
    expect(reclassification.resolution).toBe('APPLIED');
    expect(reclassification.movement_id).toBeTruthy();

    const balance = await readBalance(product.id);
    expect(Number(balance.qty_available)).toBe(25);
    expect(Number(balance.qty_damaged)).toBe(5);
  });

  it('RD-DB: CHECK stock_reclassification_avaria_requires_photo rejeita INSERT cru sem fotos', async () => {
    const product = await seedProductWithBalance(10);
    await expect(
      testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `INSERT INTO wms.stock_reclassification (tenant_id, warehouse_id, product_id, location_id, request_type, from_bucket, qty, photo_keys, status, resolution, created_by)
         VALUES ($1,$2,$3,$4,'RECLASSIFICACAO_AVARIA','AVAILABLE',1,'{}','RESOLVED','APPLIED',$5)`,
        [clientId, warehouseId, product.id, locationId, SEED_ACTOR_ID]
      )
    ).rejects.toThrow();
  });

  it('RF-EST-031: descarte exige exceção EST.DESCARTE_SALDO de 2 passos com aprovadores distintos', async () => {
    const product = await seedProductWithBalance(20);
    // Aplica avaria primeiro para ter saldo DAMAGED a descartar.
    await stockReclassificationService.registerAvaria({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      fromBucket: 'AVAILABLE',
      qty: 8,
      photoKeys: ['s3://evidencias/avaria-2.jpg'],
      actorUserId: SEED_ACTOR_ID,
    });

    const aprovador1 = await createTestUser(testContext.databaseService, passwordService);
    const aprovador2 = await createTestUser(testContext.databaseService, passwordService);
    for (const user of [aprovador1, aprovador2]) {
      await assignRole(testContext.databaseService, { userId: user.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    }

    const request = await stockReclassificationService.requestDiscard({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      sourceBucket: 'DAMAGED',
      qty: 8,
      reasonRequest: 'Item avariado sem condição de recuperação',
      actorUserId: SEED_ACTOR_ID,
    });
    expect(request.status).toBe('PENDING');
    expect(request.operational_exception_id).toBeTruthy();

    const step1 = await stockReclassificationService.decideDiscard(request.id, clientId, warehouseId, aprovador1.id, 'APPROVE', 'Passo 1 ok');
    expect(step1.applied).toBe(false);
    let balance = await readBalance(product.id);
    expect(Number(balance.qty_damaged)).toBe(8); // ainda não efetivado

    const step2 = await stockReclassificationService.decideDiscard(request.id, clientId, warehouseId, aprovador2.id, 'APPROVE', 'Passo 2 ok');
    expect(step2.applied).toBe(true);
    expect(step2.reclassification.status).toBe('RESOLVED');
    expect(step2.reclassification.resolution).toBe('DISCARDED');

    balance = await readBalance(product.id);
    expect(Number(balance.qty_damaged)).toBe(0);
  });

  it('RF-EST-031: descarte rejeitado não efetiva baixa de saldo', async () => {
    const product = await seedProductWithBalance(20);
    await stockReclassificationService.registerAvaria({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      fromBucket: 'AVAILABLE',
      qty: 6,
      photoKeys: ['s3://evidencias/avaria-3.jpg'],
      actorUserId: SEED_ACTOR_ID,
    });

    const aprovador = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: aprovador.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });

    const request = await stockReclassificationService.requestDiscard({
      tenantId: clientId,
      warehouseId,
      productId: product.id,
      locationId,
      sourceBucket: 'DAMAGED',
      qty: 6,
      reasonRequest: 'Solicitação de descarte',
      actorUserId: SEED_ACTOR_ID,
    });

    // REJECT finaliza no 1º passo (decide() marca REJECTED imediatamente, independente de default_steps).
    const decision = await stockReclassificationService.decideDiscard(request.id, clientId, warehouseId, aprovador.id, 'REJECT', 'Ainda pode ser recuperado');
    expect(decision.applied).toBe(true);
    expect(decision.reclassification.resolution).toBe('REJECTED');

    const balance = await readBalance(product.id);
    expect(Number(balance.qty_damaged)).toBe(6); // saldo preservado
  });
});
