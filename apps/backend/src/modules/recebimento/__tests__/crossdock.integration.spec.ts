// DOC-04 §4.6/§6 — CrossDockService: RN-REC-050 (elegibilidade), RF-REC-051
// (fluxo), RNF-REC-052 (alerta de permanência). Cenários Gherkin cobertos
// (§6, na medida do que está em escopo desta sessão — DOC-05/DOC-06 não
// implementados): "Cross-docking pula o picking" (formação do palete em
// zona CROSS_DOCKING), "Cancelamento do pedido desfaz o cross-docking"
// (cancelLink).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ConfigService } from '@nestjs/config';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { LocationService } from '../../cadastro/location/location.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { InboundOrderService } from '../inbound-order/inbound-order.service.js';
import { CheckingService } from '../checking/checking.service.js';
import { CrossDockService } from '../crossdock/crossdock.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Recebimento - DOC-04 §4.6/§6 CrossDockService', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let checkingService: CheckingService;
  let crossDockService: CrossDockService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;
  let clientId: string;
  let warehouseId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    const fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const lpnService = new LpnService(documentNumberingService);
    const palletService = new PalletService(db, lpnService);

    inboundOrderService = new InboundOrderService(
      db,
      eventsService,
      auditService,
      operationalExceptionService,
      operationFlowService,
      fileStorageService,
      documentNumberingService
    );
    checkingService = new CheckingService(db, eventsService, auditService, operationalExceptionService, operationFlowService);
    crossDockService = new CrossDockService(db, eventsService, auditService, palletService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    const locationService = new LocationService(db, auditService);
    productService = new ProductService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém crossdock', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente crossdock', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.CROSSDOCK_TEMPO_MAX_H', '24')`,
      []
    );

    // GS1_PREFIX próprio: sem isso, LpnService usa o mesmo default
    // ('2900000') de QUALQUER outro armazém sem prefixo configurado — o
    // "1º palete" de dois armazéns diferentes colide em `pallet_lpn_unique`
    // (achado real, ver §3-BIS "5 bugs REAIS adicionais" no handoff desta
    // sessão — LpnService/DEFAULT_GS1_PREFIX, DÉBITO DOC-02).
    await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7419998', $1)`,
      [warehouseId]
    );

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'XDK', name: 'Cross-docking', zone_type: 'CROSS_DOCKING' }, SEED_ACTOR_ID);
    await locationService.create(
      {
        warehouse_id: warehouseId,
        zone_id: zone.id,
        aisle: 'X1',
        module: '001',
        level: '00',
        slot: '01',
        location_type: 'CROSS_DOCK',
        max_weight_kg: 1000,
        max_volume_m3: 5,
        max_pallets: 10,
        max_height_m: 3,
      },
      SEED_ACTOR_ID
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /** Cria uma Ordem manual com 1 item e a leva até CHECKING (itens CHECKING_PENDING), sem contar ainda. */
  async function bringOrderToChecking(qty: number) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Item cross-dock', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: qty }] }, SEED_ACTOR_ID);

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });
    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    return { order: created.order, item: created.items[0], checking };
  }

  it('Cross-docking pula o picking: vínculo antes da conferência + palete formado direto em zona CROSS_DOCKING (RN-REC-050/RF-REC-051)', async () => {
    const { item, checking } = await bringOrderToChecking(40);

    const link = await crossDockService.linkToOutboundOrder(item.id, clientId, warehouseId, 'PED-SP01-00000200', 40, SEED_ACTOR_ID);
    expect(link.status).toBe('RESERVED');

    await checkingService.countFirstRound(checking.id, item.id, 40, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);

    const pallet = await crossDockService.formCrossDockPallet(clientId, warehouseId, 'PBR', [link.id], SEED_ACTOR_ID);
    expect(pallet.lpn).toMatch(/^[0-9]{18}$/);

    const palletResult = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT * FROM wms.pallet WHERE id = $1`, [pallet.id]);
    expect(palletResult.rows[0].status).toBe('STORED');
    expect(palletResult.rows[0].current_location_id).not.toBeNull();

    const linkResult = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT * FROM wms.crossdock_link WHERE id = $1`, [link.id]);
    expect(linkResult.rows[0].status).toBe('CONSUMED');
    expect(linkResult.rows[0].pallet_id).toBe(pallet.id);

    const contentResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.pallet_content WHERE pallet_id = $1`,
      [pallet.id]
    );
    expect(Number(contentResult.rows[0].qty)).toBe(40);
    // [LACUNA: DOC-05/DOC-06 não implementados] — não há wms.stock_balance
    // nem outbound_order reais para verificar "saldo com reserva imediata"
    // ou "Pedido pula Picking" além do que já está implementado aqui.
  });

  it('rejeita vínculo de cross-docking após a conferência já ter concluído o item (RN-REC-050)', async () => {
    const { item, checking } = await bringOrderToChecking(10);
    await checkingService.countFirstRound(checking.id, item.id, 10, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);

    await expect(crossDockService.linkToOutboundOrder(item.id, clientId, warehouseId, 'PED-SP01-00000201', 5, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'ITEM_ALREADY_CHECKED' },
    });
  });

  it('rejeita vínculo que excede qty_expected (parcial permitido, mas não além do total)', async () => {
    const { item } = await bringOrderToChecking(20);
    await crossDockService.linkToOutboundOrder(item.id, clientId, warehouseId, 'PED-SP01-00000202', 15, SEED_ACTOR_ID);

    await expect(crossDockService.linkToOutboundOrder(item.id, clientId, warehouseId, 'PED-SP01-00000203', 10, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'QTY_EXCEEDS_EXPECTED' },
    });
  });

  it('Cancelamento do pedido desfaz o cross-docking: reserva RESERVED -> CANCELLED', async () => {
    const { item } = await bringOrderToChecking(12);
    const link = await crossDockService.linkToOutboundOrder(item.id, clientId, warehouseId, 'PED-SP01-00000204', 12, SEED_ACTOR_ID);

    const cancelled = await crossDockService.cancelLink(link.id, clientId, warehouseId, 'Pedido de saída cancelado pelo cliente', SEED_ACTOR_ID);
    expect(cancelled.status).toBe('CANCELLED');

    await expect(crossDockService.cancelLink(link.id, clientId, warehouseId, 'segunda tentativa', SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'LINK_ALREADY_CANCELLED' },
    });
    // [DÉBITO: Sessão 4B] "o sistema gera tarefas de putaway normal" não é
    // verificado aqui — depende do motor de putaway, fora de escopo.
  });

  it('RNF-REC-052: crossdock_link CONSUMED além do tempo máximo gera alerta', async () => {
    const { item, checking } = await bringOrderToChecking(8);
    const link = await crossDockService.linkToOutboundOrder(item.id, clientId, warehouseId, 'PED-SP01-00000205', 8, SEED_ACTOR_ID);
    await checkingService.countFirstRound(checking.id, item.id, 8, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);
    await crossDockService.formCrossDockPallet(clientId, warehouseId, 'PBR', [link.id], SEED_ACTOR_ID);

    // Simula permanência além de REC.CROSSDOCK_TEMPO_MAX_H (24h) — recua
    // updated_at. wms.crossdock_link tem RLS: precisa de db.query() com
    // contexto de tenant, queryGlobal() não veria a linha (0 rows affected,
    // sem erro) e o teste falharia silenciosamente mais abaixo.
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.crossdock_link SET updated_at = now() - interval '25 hours' WHERE id = $1`,
      [link.id]
    );

    const result = await crossDockService.checkAging();
    expect(result.alertedLinkIds).toContain(link.id);
  });
});
