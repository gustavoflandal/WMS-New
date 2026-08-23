// DOC-04 RF-REC-010/RN-REC-011/RN-REC-012 — InboundOrderService (Ordem de
// Recebimento por XML de NF-e e por digitação manual). Reaproveita o gate-in
// REAL do DOC-03 (não um vehicle_visit inserido via SQL cru) para chegar a um
// estado NO_PATIO — mesmo padrão de fidelidade já usado pelos testes de
// portaria (gate-in-within-window.integration.spec.ts).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ConfigService } from '@nestjs/config';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ProductBarcodeService } from '../../cadastro/product-barcode/product-barcode.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { InboundOrderService } from '../inbound-order/inbound-order.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate, buildTimeWindow } from '../../portaria/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../core/__tests__/security-test-helpers.js';

// [[wms-midnight-flaky-window-config-test]] — ver buildTimeWindow() em
// portaria/__tests__/test-helpers.ts (fonte única desta lógica agora;
// existiam N cópias quase-idênticas espalhadas por arquivo de teste).
function windowCoveringNow(marginMinutes = 60) {
  return buildTimeWindow(-marginMinutes, marginMinutes);
}

function randomAccessKey(): string {
  let digits = '';
  for (let i = 0; i < 44; i++) digits += Math.floor(Math.random() * 10).toString();
  return digits;
}

function buildNfeXml(opts: { accessKey: string; issuerCnpj: string; totalValue: string; items: { sku: string; ean?: string; ncm?: string; description: string; qty: string }[] }): string {
  const detBlocks = opts.items
    .map(
      (it) => `
    <det>
      <prod>
        <cProd>${it.sku}</cProd>
        <cEAN>${it.ean ?? 'SEM GTIN'}</cEAN>
        <xProd>${it.description}</xProd>
        <NCM>${it.ncm ?? '00000000'}</NCM>
        <qCom>${it.qty}</qCom>
      </prod>
    </det>`
    )
    .join('');
  return `<NFe>
  <infNFe Id="NFe${opts.accessKey}">
    <emit>
      <CNPJ>${opts.issuerCnpj}</CNPJ>
      <xNome>Fornecedor Teste</xNome>
    </emit>
    ${detBlocks}
    <total>
      <ICMSTot>
        <vNF>${opts.totalValue}</vNF>
      </ICMSTot>
    </total>
  </infNFe>
</NFe>`;
}

describe('Recebimento - DOC-04 RF-REC-010/RN-REC-011/RN-REC-012 InboundOrderService', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let operationalExceptionService: OperationalExceptionService;
  let operationFlowService: OperationFlowService;
  let fileStorageService: FileStorageService;
  let productService: ProductService;
  let productBarcodeService: ProductBarcodeService;
  let portariaServices: PortariaServices;
  let clientId: string;
  let warehouseId: string;
  let windowConfigId: string;
  let approver1: { id: string };
  let approver2: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();

    inboundOrderService = new InboundOrderService(
      db,
      eventsService,
      auditService,
      operationalExceptionService,
      operationFlowService,
      fileStorageService,
      documentNumberingService
    );

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    productBarcodeService = new ProductBarcodeService(db);
    portariaServices = setupPortariaServices(db);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém recebimento', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;

    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente recebimento', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await settingsService.create(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        fiscal_mode: 'EMISSAO_PROPRIA',
        inbound_invoice_deadline_days: 15,
        default_giro_policy: 'FIFO',
        blind_checking: true,
      },
      SEED_ACTOR_ID
    );

    // Várias vagas de pátio livres (cada gate-in desta suíte ocupa uma vaga
    // e nunca faz gate-out, então uma só vaga esgotaria após o 1º teste) +
    // UMA janela de agendamento compartilhada por todos os testes (capacity
    // alta o bastante para várias chamadas) — criar uma janela por teste
    // colide em (warehouse_id, weekday, start_time, end_time, direction),
    // UNIQUE em appointment_window_config.
    for (let i = 0; i < 10; i++) {
      await db.queryGlobal(`INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,$2,'WAITING',$3)`, [
        warehouseId,
        `Y${String(i).padStart(2, '0')}`,
        SEED_ACTOR_ID,
      ]);
    }
    const window = windowCoveringNow(120);
    const windowConfig = await portariaServices.windowConfigService.create(
      { warehouse_id: warehouseId, weekday: window.weekday, start_time: window.start_time, end_time: window.end_time, direction: 'INBOUND', capacity: 50 },
      SEED_ACTOR_ID
    );
    windowConfigId = windowConfig.id;

    const passwordService = new PasswordService(db);
    approver1 = await createTestUser(db, passwordService);
    approver2 = await createTestUser(db, passwordService);
    for (const approver of [approver1, approver2]) {
      await assignRole(db, { userId: approver.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    }
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'REC.RECUSA_TOTAL', warehouseId, maxQty: 100000 });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /** Leva um veículo até NO_PATIO (gate-in confirmado) com a(s) chave(s) de NF-e informada(s) — pré-requisito de RN-REC-011. */
  async function gateInWithNfeKeys(nfeKeys: string[]) {
    const window = windowCoveringNow(120);
    const appointment = await portariaServices.appointmentService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, direction: 'INBOUND', window_config_id: windowConfigId, window_date: window.window_date, vehicle_type: 'TRUCK' },
      SEED_ACTOR_ID
    );
    const visit = await portariaServices.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista Teste', cnh: 'CNH123456', cnh_validity: '2030-01-01' },
        appointment_id: appointment.id,
        nfe_keys: nfeKeys,
      },
      SEED_ACTOR_ID
    );
    expect(visit.status).toBe('NO_PATIO');
    return visit;
  }

  it('cria Ordem a partir de XML com item casado por SKU, vinculada ao gate-in via nfe_keys, com inbound_invoice registrada (RN-REC-011)', async () => {
    const sku = randomSku();
    const product = await productService.create(
      { tenant_id: clientId, sku, description: 'Produto casado por SKU', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );

    const accessKey = randomAccessKey();
    const visit = await gateInWithNfeKeys([accessKey]);

    const xml = buildNfeXml({
      accessKey,
      issuerCnpj: generateValidCnpj(),
      totalValue: '1000.00',
      items: [{ sku, description: 'Produto casado por SKU', qty: '100' }],
    });

    const result = await inboundOrderService.createFromXml({ tenantId: clientId, warehouseId, xmlContent: xml }, SEED_ACTOR_ID);

    expect(result.order.origin).toBe('XML_NFE');
    expect(result.order.status).toBe('CREATED');
    expect(result.order.vehicle_visit_id).toBe(visit.id);
    expect(result.order.number).toMatch(/^REC-/);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].product_id).toBe(product.id);
    expect(result.items[0].status).toBe('PENDING');
    expect(Number(result.items[0].qty_expected)).toBe(100);

    expect(result.invoice).not.toBeNull();
    expect(result.invoice.access_key).toBe(accessKey);
    expect(Number(result.invoice.total_value)).toBe(1000);
    expect(result.invoice.xml_storage_key).toBeTruthy();
    expect(await fileStorageService.exists(result.invoice.xml_storage_key)).toBe(true);

    // Fluxo Operacional: CHEGADA já DONE, DOCA é a próxima pendente (RF-REC-020).
    const flowResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT fs.step_code, fs.status FROM wms.flow_step fs
       JOIN wms.operation_flow f ON f.id = fs.operation_flow_id
       WHERE f.entity = 'inbound_order' AND f.entity_id = $1 ORDER BY fs.sequence_order ASC`,
      [result.order.id]
    );
    expect(flowResult.rows.map((r: any) => `${r.step_code}:${r.status}`)).toEqual([
      'CHEGADA:DONE',
      'DOCA:PENDING',
      'DESCARGA:PENDING',
      'CONFERENCIA:PENDING',
      'ETIQUETAGEM:PENDING',
      'PUTAWAY:PENDING',
      'FIM:PENDING',
    ]);
  });

  it('item sem produto casado vira SEM_CADASTRO e abre REC.PRODUTO_SEM_CADASTRO (RN-REC-012)', async () => {
    const accessKey = randomAccessKey();
    await gateInWithNfeKeys([accessKey]);

    const xml = buildNfeXml({
      accessKey,
      issuerCnpj: generateValidCnpj(),
      totalValue: '50.00',
      items: [{ sku: 'SKU-INEXISTENTE-XYZ', description: 'Produto nunca cadastrado', qty: '10' }],
    });

    const result = await inboundOrderService.createFromXml({ tenantId: clientId, warehouseId, xmlContent: xml }, SEED_ACTOR_ID);

    expect(result.items[0].status).toBe('SEM_CADASTRO');
    expect(result.items[0].product_id).toBeNull();

    const exceptionResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.operational_exception WHERE entity = 'inbound_order_item' AND entity_id = $1`,
      [result.items[0].id]
    );
    expect(exceptionResult.rows).toHaveLength(1);
    expect(exceptionResult.rows[0].exception_type).toBe('REC.PRODUTO_SEM_CADASTRO');
  });

  it('item casado por EAN (product_barcode) quando o SKU não bate (RN-REC-012)', async () => {
    const sku = randomSku();
    const ean = '789' + Math.floor(Math.random() * 1e10).toString().padStart(10, '0');
    const product = await productService.create(
      { tenant_id: clientId, sku, description: 'Produto casado por EAN', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    await productBarcodeService.create({ tenant_id: clientId, product_id: product.id, barcode: ean, barcode_type: 'EAN13' }, SEED_ACTOR_ID);

    const accessKey = randomAccessKey();
    await gateInWithNfeKeys([accessKey]);

    const xml = buildNfeXml({
      accessKey,
      issuerCnpj: generateValidCnpj(),
      totalValue: '200.00',
      items: [{ sku: 'SKU-DIFERENTE-DO-CADASTRO', ean, description: 'Descrição divergente', qty: '5' }],
    });

    const result = await inboundOrderService.createFromXml({ tenantId: clientId, warehouseId, xmlContent: xml }, SEED_ACTOR_ID);
    expect(result.items[0].product_id).toBe(product.id);
    expect(result.items[0].status).toBe('PENDING');
  });

  it('rejeita XML com chave de NF-e já registrada (idempotência)', async () => {
    const accessKey = randomAccessKey();
    await gateInWithNfeKeys([accessKey]);
    const xml = buildNfeXml({ accessKey, issuerCnpj: generateValidCnpj(), totalValue: '10.00', items: [{ sku: randomSku(), description: 'Item', qty: '1' }] });

    await inboundOrderService.createFromXml({ tenantId: clientId, warehouseId, xmlContent: xml }, SEED_ACTOR_ID);
    await expect(inboundOrderService.createFromXml({ tenantId: clientId, warehouseId, xmlContent: xml }, SEED_ACTOR_ID)).rejects.toThrow();
  });

  it('cria Ordem sem vehicle_visit casado (ASN pré-chegada, RF-REC-010(a)) sem registrar inbound_invoice ainda', async () => {
    const accessKey = randomAccessKey();
    // Nenhum gate-in com esta chave -- ASN enviado antes da chegada física.
    const xml = buildNfeXml({ accessKey, issuerCnpj: generateValidCnpj(), totalValue: '300.00', items: [{ sku: randomSku(), description: 'Item pré-chegada', qty: '20' }] });

    const result = await inboundOrderService.createFromXml({ tenantId: clientId, warehouseId, xmlContent: xml }, SEED_ACTOR_ID);
    expect(result.order.vehicle_visit_id).toBeNull();
    expect(result.invoice).toBeNull();
  });

  it('cria Ordem manual com item do catálogo do cliente (RF-REC-010(c))', async () => {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto para digitação manual', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );

    const result = await inboundOrderService.createManual(
      { tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: 42 }] },
      SEED_ACTOR_ID
    );

    expect(result.order.origin).toBe('MANUAL');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].product_id).toBe(product.id);
    expect(Number(result.items[0].qty_expected)).toBe(42);
  });

  it('rejeita Ordem manual com produto inexistente', async () => {
    await expect(
      inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: '00000000-0000-0000-0000-000000000099', qtyExpected: 1 }] }, SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'PRODUCT_NOT_FOUND' } });
  });

  it('cancela Ordem CREATED (sem contagem iniciada) e rejeita cancelar de novo (§5.1)', async () => {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto para cancelamento', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual(
      { tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: 1 }] },
      SEED_ACTOR_ID
    );

    const cancelled = await inboundOrderService.cancel(created.order.id, clientId, warehouseId, 'Pedido cancelado a pedido do cliente', SEED_ACTOR_ID);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.refusal_reason).toBe('Pedido cancelado a pedido do cliente');

    await expect(inboundOrderService.cancel(created.order.id, clientId, warehouseId, 'segunda tentativa', SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'ORDER_NOT_CANCELLABLE' },
    });
  });

  it('RN-REC-023: REC.RECUSA_TOTAL exige 2 aprovadores distintos e transiciona AT_DOCK -> REFUSED', async () => {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto para recusa total', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: 1 }] }, SEED_ACTOR_ID);

    // Não é possível recusar uma Ordem ainda CREATED (§5.1: só AT_DOCK/UNLOADING).
    await expect(
      inboundOrderService.requestTotalRefusal(created.order.id, clientId, warehouseId, 'Carga avariada no transporte', SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'ORDER_NOT_REFUSABLE' } });

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });

    const { exception } = await inboundOrderService.requestTotalRefusal(created.order.id, clientId, warehouseId, 'Carga avariada no transporte', SEED_ACTOR_ID);
    expect(exception.status).toBe('PENDING');

    // Ainda não decidida: aplicar a decisão deve ser rejeitado.
    await expect(inboundOrderService.applyTotalRefusalDecision(created.order.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'REFUSAL_NOT_APPROVED' },
    });

    // Passo 1: approver1 aprova -> ainda PENDING (falta o 2º passo, RN-SEG-043).
    const afterStep1 = await operationalExceptionService.decide(exception.id, clientId, warehouseId, approver1.id, 'APPROVE', 'Confirmo avaria relatada');
    expect(afterStep1.status).toBe('PENDING');
    await expect(inboundOrderService.applyTotalRefusalDecision(created.order.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'REFUSAL_NOT_APPROVED' },
    });

    // Passo 2: approver2 (distinto) aprova -> finaliza APPROVED.
    const afterStep2 = await operationalExceptionService.decide(exception.id, clientId, warehouseId, approver2.id, 'APPROVE', 'Segunda aprovação, recusa confirmada');
    expect(afterStep2.status).toBe('APPROVED');

    const refused = await inboundOrderService.applyTotalRefusalDecision(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(refused.status).toBe('REFUSED');
    expect(refused.refusal_reason).toBe('Carga avariada no transporte');
  });
});
