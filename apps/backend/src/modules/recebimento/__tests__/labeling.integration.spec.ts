// DOC-04 §4.4 — LabelingService: RF-REC-030 (formação de paletes/LPN,
// palete misto), RN-REC-031 (quarentena por espécie). `wms.app_parameter`
// é limpo entre arquivos de teste por cleanTestData() (ver memória
// "app_parameter test gap") — os parâmetros REC.* usados aqui são
// inseridos diretamente no fixture, nunca herdados do seed das migrations.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ConfigService } from '@nestjs/config';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { InboundOrderService } from '../inbound-order/inbound-order.service.js';
import { CheckingService } from '../checking/checking.service.js';
import { LabelingService } from '../labeling/labeling.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Recebimento - DOC-04 §4.4 LabelingService', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let checkingService: CheckingService;
  let labelingService: LabelingService;
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
    const batchService = new BatchService(db, auditService);

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
    labelingService = new LabelingService(db, eventsService, auditService, palletService, batchService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém labeling', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente labeling', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    // GS1_PREFIX próprio para este armazém: sem isso, LpnService usa
    // DEFAULT_GS1_PREFIX ('2900000') igual para QUALQUER armazém sem
    // prefixo configurado — o "1º palete" de dois armazéns diferentes sem
    // prefixo próprio colide (mesmo prefixo + mesmo sequencial=1),
    // violando `pallet_lpn_unique` (GLOBAL). Achado real ao rodar esta
    // suíte junto com lpn-generation.integration.spec.ts (que também usa
    // um armazém sem prefixo próprio) — [DÉBITO: DOC-02/LpnService,
    // Sessão futura — o fallback padrão não é seguro para uso concorrente
    // por múltiplos armazéns; produção real precisaria exigir GS1_PREFIX
    // configurado por armazém, não um default compartilhado]. Contornado
    // aqui exatamente como a produção deveria operar: cada armazém com seu
    // próprio prefixo GS1 real.
    await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7419999', $1)`,
      [warehouseId]
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /** Leva uma Ordem manual (itens já com espécie/qty definidos) até LABELING, com todos os itens CHECKED. */
  async function bringOrderToLabeling(items: { sku: string; qty: number; species?: string; description?: string }[]) {
    const productIds: string[] = [];
    for (const it of items) {
      const product = await productService.create(
        { tenant_id: clientId, sku: it.sku, description: it.description ?? `Produto ${it.sku}`, species_code: it.species ?? 'GERAL', base_uom: 'UN' },
        SEED_ACTOR_ID
      );
      productIds.push(product.id);
    }

    const created = await inboundOrderService.createManual(
      { tenantId: clientId, warehouseId, items: items.map((it, idx) => ({ productId: productIds[idx], qtyExpected: it.qty })) },
      SEED_ACTOR_ID
    );

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });

    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    for (const item of created.items) {
      await checkingService.countFirstRound(checking.id, item.id, Number(item.qty_expected), SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);
    }
    await checkingService.closeChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const order = await labelingService.startLabeling(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    return { order, items: created.items };
  }

  it('forma um palete com 1 produto/lote, gera LPN válido e atualiza o progresso de paletização', async () => {
    const { order, items } = await bringOrderToLabeling([{ sku: randomSku(), qty: 20 }]);

    const pallet = await labelingService.formPallet(
      order.id,
      clientId,
      warehouseId,
      'PBR',
      [{ inboundOrderItemId: items[0].id, qty: 20, batchCode: 'LOTE-001', manufactureDate: '2026-01-01' }],
      SEED_ACTOR_ID
    );
    expect(pallet.lpn).toMatch(/^[0-9]{18}$/);
    expect(pallet.status).toBe('IN_RECEIVING');

    const palletResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.pallet WHERE id = $1`,
      [pallet.id]
    );
    expect(palletResult.rows[0].inbound_order_id).toBe(order.id);

    const progress = await labelingService.getLabelingProgress(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(progress).toHaveLength(1);
    expect(progress[0].qtyPalletized).toBe(20);
    expect(progress[0].qtyRemaining).toBe(0);
  });

  it('rejeita quantidade que excede o restante a paletizar do item', async () => {
    const { order, items } = await bringOrderToLabeling([{ sku: randomSku(), qty: 10 }]);

    await expect(
      labelingService.formPallet(order.id, clientId, warehouseId, 'PBR', [{ inboundOrderItemId: items[0].id, qty: 11 }], SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'QTY_EXCEEDS_REMAINING' } });
  });

  it('palete misto: permitido por padrão (parâmetro ausente = true), rejeitado quando REC.PERMITE_PALETE_MISTO=false', async () => {
    const { order, items } = await bringOrderToLabeling([
      { sku: randomSku(), qty: 5 },
      { sku: randomSku(), qty: 5 },
    ]);

    const mixedPallet = await labelingService.formPallet(
      order.id,
      clientId,
      warehouseId,
      'PBR',
      [
        { inboundOrderItemId: items[0].id, qty: 5 },
        { inboundOrderItemId: items[1].id, qty: 5 },
      ],
      SEED_ACTOR_ID
    );
    expect(mixedPallet.lpn).toMatch(/^[0-9]{18}$/);

    // Novo cenário com REC.PERMITE_PALETE_MISTO=false explícito.
    const { order: order2, items: items2 } = await bringOrderToLabeling([
      { sku: randomSku(), qty: 5 },
      { sku: randomSku(), qty: 5 },
    ]);
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.PERMITE_PALETE_MISTO', 'false')`,
      []
    );

    await expect(
      labelingService.formPallet(
        order2.id,
        clientId,
        warehouseId,
        'PBR',
        [
          { inboundOrderItemId: items2[0].id, qty: 5 },
          { inboundOrderItemId: items2[1].id, qty: 5 },
        ],
        SEED_ACTOR_ID
      )
    ).rejects.toMatchObject({ response: { error: 'MIXED_PALLET_NOT_ALLOWED' } });

    await testContext.databaseService.queryGlobal(`DELETE FROM wms.app_parameter WHERE name = 'REC.PERMITE_PALETE_MISTO'`);
  });

  it('RN-REC-031: lote de espécie em REC.QUARENTENA_ESPECIES nasce QUARANTINE; liberação muda para RELEASED', async () => {
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.QUARENTENA_ESPECIES', '["MEDICAMENTO"]')`,
      []
    );

    const { order, items } = await bringOrderToLabeling([{ sku: randomSku(), qty: 8, species: 'MEDICAMENTO', description: 'Medicamento X' }]);

    const pallet = await labelingService.formPallet(
      order.id,
      clientId,
      warehouseId,
      'PBR',
      [{ inboundOrderItemId: items[0].id, qty: 8, batchCode: 'LOTE-MED-01', manufactureDate: '2026-01-01', expirationDate: '2027-01-01' }],
      SEED_ACTOR_ID
    );

    const contentResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT batch_id FROM wms.pallet_content WHERE pallet_id = $1`,
      [pallet.id]
    );
    const batchId = contentResult.rows[0].batch_id;
    const batchResult = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT * FROM wms.batch WHERE id = $1`, [batchId]);
    expect(batchResult.rows[0].status).toBe('QUARANTINE');

    const released = await labelingService.releaseQuarantine(batchId, clientId, warehouseId, 'Laudo de qualidade aprovado', SEED_ACTOR_ID);
    expect(released.status).toBe('RELEASED');

    await expect(labelingService.releaseQuarantine(batchId, clientId, warehouseId, 'segunda tentativa', SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'BATCH_NOT_IN_QUARANTINE' },
    });

    await testContext.databaseService.queryGlobal(`DELETE FROM wms.app_parameter WHERE name = 'REC.QUARENTENA_ESPECIES'`);
  });

  it('rejeita formar palete com item ainda não CHECKED ou Ordem fora de LABELING', async () => {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Item não conferido', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: 5 }] }, SEED_ACTOR_ID);

    // Ordem ainda CREATED (nem chegou a LABELING).
    await expect(
      labelingService.formPallet(created.order.id, clientId, warehouseId, 'PBR', [{ inboundOrderItemId: created.items[0].id, qty: 5 }], SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'ORDER_NOT_LABELING' } });
  });
});
