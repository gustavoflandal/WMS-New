// DOC-08 §4.7/§4.9/§5.1 (Sessão 8B) — motor de emissão NF-e real contra
// Postgres+Redis reais e o SefazSimulatorAdapter (que É "real" no sentido
// do CLAUDE.md: um adaptador de verdade, só que apontando para respostas
// determinísticas em vez da rede — nunca mock de framework). Cobre os
// cenários Gherkin do prompt §4: consumo só efetiva na autorização
// (cStat 539), contingência automática, e a integração com
// DispatchService.confirmFiscalDocuments (idempotência REJECTED/DENIED).
import * as forge from 'node-forge';
import { v4 as uuid } from 'uuid';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { CacheModule } from '../../../../core/cache/cache.module.js';
import { CacheService } from '../../../../core/cache/cache.service.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { ZoneService } from '../../../cadastro/zone/zone.service.js';
import { DocumentNumberingService } from '../../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { OperationFlowService } from '../../../../core/operation-flow/operation-flow.service.js';
import { ApprovalAuthorityService } from '../../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../../core/workflow/operational-exception.service.js';
import { PasswordService } from '../../../../core/auth/password.service.js';
import { FileStorageService } from '../../../../core/storage/file-storage.service.js';
import { SecretCipherService } from '../../../../core/security/secret-cipher.service.js';
import { OutboundFlowService } from '../../../expedicao/order/outbound-flow.service.js';
import { StorageInvoiceService } from '../../storage-invoice/storage-invoice.service.js';
import { FiscalConsumptionService } from '../../consumption/fiscal-consumption.service.js';
import { StorageReturnInvoiceService } from '../../storage-return-invoice/storage-return-invoice.service.js';
import { DispatchService } from '../../../expedicao/dispatch/dispatch.service.js';
import { FiscalIssuerService } from '../fiscal-issuer.service.js';
import { DanfeService } from '../danfe.service.js';
import { FiscalEmissionService } from '../fiscal-emission.service.js';
import { SefazSimulatorAdapter } from '../sefaz-simulator.adapter.js';
import { FiscalSefazAvailabilityWorkerImpl } from '../../../../workers/fiscal-sefaz-availability.worker.impl.js';
import { FiscalNumberInutilizacaoWorkerImpl } from '../../../../workers/fiscal-number-inutilizacao.worker.impl.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../../core/__tests__/security-test-helpers.js';

describe('Fiscal - DOC-08 §4.7/§4.9/§5.1 motor de emissão NF-e (Sessão 8B)', () => {
  let testContext: TestContext;

  let productService: ProductService;
  let storageInvoiceService: StorageInvoiceService;
  let storageReturnInvoiceService: StorageReturnInvoiceService;
  let dispatchService: DispatchService;
  let fiscalIssuerService: FiscalIssuerService;
  let fiscalEmissionService: FiscalEmissionService;
  let sefazSimulator: SefazSimulatorAdapter;
  let cacheService: CacheService;
  let operationalExceptionService: OperationalExceptionService;
  let fileStorageService: FileStorageService;

  let clientId: string;
  let warehouseId: string;
  let issuerId: string;
  let solicitante: { id: string };
  let aprovador1: { id: string };
  let aprovador2: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest([CacheModule]);
    const db = testContext.databaseService;
    cacheService = testContext.module.get<CacheService>(CacheService);
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const operationFlowService = new OperationFlowService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const documentNumberingService = new DocumentNumberingService(db);
    const outboundFlowService = new OutboundFlowService(db, eventsService, operationFlowService);
    const passwordService = new PasswordService(db);
    fileStorageService = new FileStorageService(testContext.configService);
    fileStorageService.onModuleInit();
    const secretCipherService = new SecretCipherService(testContext.configService);

    const fiscalConsumptionService = new FiscalConsumptionService(db);
    storageInvoiceService = new StorageInvoiceService(db, eventsService, auditService, documentNumberingService);
    storageReturnInvoiceService = new StorageReturnInvoiceService(db, eventsService, auditService, documentNumberingService, fiscalConsumptionService, fileStorageService);
    dispatchService = new DispatchService(db, eventsService, auditService, outboundFlowService, storageReturnInvoiceService);

    fiscalIssuerService = new FiscalIssuerService(db, auditService, secretCipherService);
    const danfeService = new DanfeService(db, fileStorageService);
    sefazSimulator = new SefazSimulatorAdapter();
    fiscalEmissionService = new FiscalEmissionService(db, eventsService, fileStorageService, fiscalIssuerService, danfeService, storageReturnInvoiceService, sefazSimulator);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém Fiscal 8B', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo', address_state: 'SP' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente Fiscal 8B', cnpj: generateValidCnpj(), address_state: 'SP' }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );
    await zoneService.create({ warehouse_id: warehouseId, code: 'STO8B', name: 'Armazenagem 8B', zone_type: 'STORAGE' }, SEED_ACTOR_ID);

    const issuer = await fiscalIssuerService.register({
      tenantId: clientId,
      warehouseId,
      cnpj: generateValidCnpj(),
      corporateName: 'Emitente Fiscal 8B Ltda',
      serie: 1,
      actorUserId: SEED_ACTOR_ID,
    });
    issuerId = issuer.id;
    const pfx = generateSelfSignedPfx('senha-teste-8b');
    await fiscalIssuerService.uploadCertificate(issuerId, clientId, warehouseId, pfx, 'senha-teste-8b', SEED_ACTOR_ID);

    solicitante = await createTestUser(db, passwordService);
    aprovador1 = await createTestUser(db, passwordService);
    aprovador2 = await createTestUser(db, passwordService);
    for (const user of [aprovador1, aprovador2]) {
      await assignRole(db, { userId: user.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    }
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'FIS.CANCELAMENTO_NFE', warehouseId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  beforeEach(() => {
    sefazSimulator.reset();
  });

  async function createProduct() {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto Fiscal 8B', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FIFO' },
      SEED_ACTOR_ID
    );
  }

  function randomAccessKey(): string {
    let key = '';
    for (let i = 0; i < 44; i++) key += Math.floor(Math.random() * 10);
    return key;
  }

  async function getClientCnpj(): Promise<string> {
    const result = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID }, `SELECT cnpj FROM wms.client WHERE id = $1`, [clientId]);
    return result.rows[0].cnpj;
  }
  async function getWarehouseCnpj(): Promise<string> {
    const result = await testContext.databaseService.queryGlobal(`SELECT cnpj FROM wms.warehouse WHERE id = $1`, [warehouseId]);
    return result.rows[0].cnpj;
  }

  async function seedInboundInvoice(productId: string, qtyReceived: number) {
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const orderResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.inbound_order (tenant_id, warehouse_id, number, origin, blind_checking, status, created_by)
       VALUES ($1,$2,$3,'XML_NFE',TRUE,'COMPLETED',$4) RETURNING id`,
      [clientId, warehouseId, `REC-8B-${uuid()}`, SEED_ACTOR_ID]
    );
    const orderId = orderResult.rows[0].id;
    await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.inbound_order_item (tenant_id, inbound_order_id, product_id, qty_expected, qty_counted, qty_received, status, created_by)
       VALUES ($1,$2,$3,$4,$4,$4,'CHECKED',$5)`,
      [clientId, orderId, productId, qtyReceived, SEED_ACTOR_ID]
    );
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 10);
    const invoiceResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.inbound_invoice (tenant_id, warehouse_id, inbound_order_id, access_key, issuer_cnpj, issuer_name, total_value, xml_storage_key, regularization_deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [clientId, warehouseId, orderId, randomAccessKey(), '12345678000199', 'Fornecedor Teste 8B', 1000, 's3://test/nf.xml', deadline.toISOString().slice(0, 10), SEED_ACTOR_ID]
    );
    return invoiceResult.rows[0];
  }

  async function seedStorageInvoiceWithBalance(productId: string, qty: number) {
    const invoice = await seedInboundInvoice(productId, qty);
    return storageInvoiceService.register({
      tenantId: clientId,
      warehouseId,
      issuerCnpj: await getClientCnpj(),
      recipientCnpj: await getWarehouseCnpj(),
      issuedAt: new Date().toISOString(),
      items: [{ productId, qty, referenceInboundInvoiceId: invoice.id }],
      actorUserId: SEED_ACTOR_ID,
    });
  }

  /** Seed mínimo de outbound_order/item — só o que confirmFiscalDocuments() lê (não passa pelo pipeline completo de picking/packing do DOC-06). */
  async function seedOutboundOrderReadyForFiscal(productId: string, qty: number) {
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const orderResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, created_by) VALUES ($1,$2,$3,'IN_DISPATCH',$4) RETURNING *`,
      [clientId, warehouseId, `PED-8B-${uuid()}`, SEED_ACTOR_ID]
    );
    const order = orderResult.rows[0];
    await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, qty_reserved, created_by)
       VALUES ($1,$2,$3,1,$4,$4,$5)`,
      [clientId, order.id, productId, qty, SEED_ACTOR_ID]
    );
    return order;
  }

  async function readFiscalDocument(id: string) {
    const result = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `SELECT * FROM wms.fiscal_document WHERE id = $1`, [id]);
    return result.rows[0];
  }

  // ───────────────────────────────────────────────────────────────────────
  // Ciclo completo DRAFT->SIGNED->TRANSMITTED->AUTHORIZED
  // ───────────────────────────────────────────────────────────────────────
  it('assemble() + processDocument() -> AUTHORIZED: consumo efetivado, DANFE gerado, outbound_order estampado', async () => {
    const product = await createProduct();
    await seedStorageInvoiceWithBalance(product.id, 100);
    const order = await seedOutboundOrderReadyForFiscal(product.id, 60);

    const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(draft.fiscal_document_id).toBeTruthy();
    expect(draft.fiscal_documents_authorized_at).toBeNull();

    const draftDoc = await readFiscalDocument(draft.fiscal_document_id);
    expect(draftDoc.status).toBe('DRAFT');

    const result = await fiscalEmissionService.processDocument(draft.fiscal_document_id, clientId, warehouseId);
    expect(result.outcome).toBe('AUTHORIZED');
    expect(result.cStat).toBe(100);

    const authorizedDoc = await readFiscalDocument(draft.fiscal_document_id);
    expect(authorizedDoc.status).toBe('AUTHORIZED');
    expect(authorizedDoc.nfe_number).toBeTruthy();
    expect(authorizedDoc.access_key).toMatch(/^\d{44}$/);
    expect(authorizedDoc.xml_storage_key).toBeTruthy();

    // RNF-FIS-063: XML gravado de verdade no MinIO (não só a chave em texto).
    expect(await fileStorageService.exists(authorizedDoc.xml_storage_key)).toBe(true);

    const orderAfter = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.outbound_order WHERE id = $1`,
      [order.id]
    );
    expect(orderAfter.rows[0].fiscal_documents_authorized_at).toBeTruthy();
    expect(orderAfter.rows[0].fiscal_rejection_detail).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Cenário normativo: "Consumo só efetiva na autorização" (cStat 539)
  // ───────────────────────────────────────────────────────────────────────
  it('rejeição cStat 539: qty_consumed NÃO é alterado e outbound_order fica com o código exposto', async () => {
    const product = await createProduct();
    const storageDoc = await seedStorageInvoiceWithBalance(product.id, 100);
    const order = await seedOutboundOrderReadyForFiscal(product.id, 50);

    const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);

    // A chave de acesso real só é conhecida DEPOIS que processDocument()
    // reserva o nNF internamente — como o simulador roteia por essa chave
    // (<simKey>), forçamos a resposta via `processWithForcedResponse`
    // (substitui `transmit()` temporariamente), em vez de tentar prever a
    // chave de antemão.
    const result = await processWithForcedResponse(draft.fiscal_document_id, { cStat: 539, cStatMessage: 'Rejeição: duplicidade de NF-e' });

    expect(result.outcome).toBe('REJECTED');
    expect(result.cStat).toBe(539);

    const rejectedDoc = await readFiscalDocument(draft.fiscal_document_id);
    expect(rejectedDoc.status).toBe('REJECTED');
    expect(rejectedDoc.rejection_detail).toContain('539');

    const balanceResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_consumed FROM wms.fiscal_stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND storage_remittance_invoice_id = $4`,
      [clientId, warehouseId, product.id, storageDoc.id]
    );
    expect(Number(balanceResult.rows[0].qty_consumed)).toBe(0);

    const orderAfter = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.outbound_order WHERE id = $1`,
      [order.id]
    );
    expect(orderAfter.rows[0].fiscal_documents_authorized_at).toBeNull();
    expect(orderAfter.rows[0].fiscal_rejection_detail).toContain('539');
  });

  /** Como o nNF/chave de acesso só existe após a reserva atômica dentro de processDocument(), forçamos a resposta usando o adapter em modo "qualquer chave" — configureResponse aceita um curinga por documento via override direto do método transmit. */
  async function processWithForcedResponse(fiscalDocumentId: string, forced: { cStat: number; cStatMessage: string }) {
    const originalTransmit = sefazSimulator.transmit.bind(sefazSimulator);
    sefazSimulator.transmit = (async (input: Parameters<typeof originalTransmit>[0]) => {
      return { cStat: forced.cStat, cStatMessage: forced.cStatMessage, protocolNumber: null, authorizedAt: null };
    }) as typeof sefazSimulator.transmit;
    try {
      const result = await fiscalEmissionService.processDocument(fiscalDocumentId, clientId, warehouseId);
      return result;
    } finally {
      sefazSimulator.transmit = originalTransmit;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Contingência automática (RNF-FIS-061)
  // ───────────────────────────────────────────────────────────────────────
  it('3 falhas de transporte consecutivas -> emitente entra em CONTINGENCIA_SVC; disponibilidade normalizada reverte para NORMAL', async () => {
    const product = await createProduct();
    await seedStorageInvoiceWithBalance(product.id, 300);

    const forceTransportError = async (fiscalDocumentId: string) => {
      const originalTransmit = sefazSimulator.transmit.bind(sefazSimulator);
      sefazSimulator.transmit = (async () => {
        throw new Error('falha de transporte simulada');
      }) as typeof sefazSimulator.transmit;
      try {
        return await fiscalEmissionService.processDocument(fiscalDocumentId, clientId, warehouseId);
      } finally {
        sefazSimulator.transmit = originalTransmit;
      }
    };

    const orders = [];
    for (let i = 0; i < 3; i++) {
      const order = await seedOutboundOrderReadyForFiscal(product.id, 10);
      const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
      const outcome = await forceTransportError(draft.fiscal_document_id);
      expect(outcome.outcome).toBe('TRANSPORT_FAILURE');
      orders.push(order);
    }

    const issuerAfterFailures = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.fiscal_issuer WHERE id = $1`,
      [issuerId]
    );
    // Regra do projeto: nunca comparar dois resultados possivelmente vazios
    // sem antes afirmar que ao menos um é não-vazio.
    expect(issuerAfterFailures.rows.length).toBeGreaterThan(0);
    expect(issuerAfterFailures.rows[0].consecutive_failures).toBeGreaterThanOrEqual(3);
    expect(issuerAfterFailures.rows[0].transmission_mode).toBe('CONTINGENCIA_SVC');

    // Monitor de disponibilidade (RNF-FIS-061): simulador reporta UF saudável -> reverte.
    sefazSimulator.configureAvailability('SP', true);
    const availabilityWorker = new FiscalSefazAvailabilityWorkerImpl(testContext.databaseService, sefazSimulator, cacheService, { pollIntervalMs: 60000 });
    const runResult = await availabilityWorker.runOnce();
    expect(runResult.ranAsLeader).toBe(true);
    expect(runResult.recoveredIssuerIds).toContain(issuerId);

    const issuerAfterRecovery = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT transmission_mode, consecutive_failures FROM wms.fiscal_issuer WHERE id = $1`,
      [issuerId]
    );
    expect(issuerAfterRecovery.rows.length).toBeGreaterThan(0);
    expect(issuerAfterRecovery.rows[0].transmission_mode).toBe('NORMAL');
    expect(issuerAfterRecovery.rows[0].consecutive_failures).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Idempotência de DispatchService.confirmFiscalDocuments (8B)
  // ───────────────────────────────────────────────────────────────────────
  describe('DispatchService.confirmFiscalDocuments — idempotência 8B', () => {
    it('REJECTED -> nova chamada volta o MESMO documento para DRAFT reaproveitando o nNF já reservado', async () => {
      const product = await createProduct();
      await seedStorageInvoiceWithBalance(product.id, 100);
      const order = await seedOutboundOrderReadyForFiscal(product.id, 20);

      const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
      await processWithForcedResponse(draft.fiscal_document_id, { cStat: 204, cStatMessage: 'Rejeição genérica' });
      const rejectedDoc = await readFiscalDocument(draft.fiscal_document_id);
      expect(rejectedDoc.status).toBe('REJECTED');
      const reservedNumber = rejectedDoc.nfe_number;
      expect(reservedNumber).toBeTruthy();

      const retried = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
      expect(retried.fiscal_document_id).toBe(draft.fiscal_document_id); // MESMO documento, não um segundo
      expect(retried.fiscal_rejection_detail).toBeNull();

      const backToDraft = await readFiscalDocument(draft.fiscal_document_id);
      expect(backToDraft.status).toBe('DRAFT');
      expect(backToDraft.nfe_number).toBe(reservedNumber); // §5.1: "correção e reenvio, MESMO número"
    });

    it('DENIED (cStat 110) -> nova chamada é bloqueada com FISCAL_NFE_DENIED_BLOCKED', async () => {
      const product = await createProduct();
      await seedStorageInvoiceWithBalance(product.id, 100);
      const order = await seedOutboundOrderReadyForFiscal(product.id, 15);

      const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
      const result = await processWithForcedResponse(draft.fiscal_document_id, { cStat: 110, cStatMessage: 'Uso Denegado' });
      expect(result.outcome).toBe('DENIED');

      await expect(dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
        response: { error: 'FISCAL_NFE_DENIED_BLOCKED' },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Inutilização mensal de número pulado (RNF-FIS-060)
  // ───────────────────────────────────────────────────────────────────────
  it('worker mensal inutiliza o nNF de um documento DENIED (cross-tenant scan + escrita tenant-scoped)', async () => {
    const product = await createProduct();
    await seedStorageInvoiceWithBalance(product.id, 100);
    const order = await seedOutboundOrderReadyForFiscal(product.id, 12);
    const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const denied = await processWithForcedResponse(draft.fiscal_document_id, { cStat: 110, cStatMessage: 'Uso Denegado' });
    expect(denied.outcome).toBe('DENIED');
    const deniedDoc = await readFiscalDocument(draft.fiscal_document_id);
    expect(deniedDoc.nfe_number).toBeTruthy();

    const inutilizacaoWorker = new FiscalNumberInutilizacaoWorkerImpl(testContext.databaseService, fileStorageService, cacheService, { pollIntervalMs: 60000 });
    const result = await inutilizacaoWorker.runOnce();
    expect(result.ranAsLeader).toBe(true);
    expect(result.inutilizedDocumentIds).toContain(draft.fiscal_document_id);

    const eventResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.fiscal_document_event WHERE fiscal_document_id = $1 AND event_type = 'INUTILIZACAO'`,
      [draft.fiscal_document_id]
    );
    expect(eventResult.rows.length).toBe(1);

    // Idempotência: rodar de novo não duplica o evento (NOT EXISTS já filtra).
    const secondRun = await inutilizacaoWorker.runOnce();
    expect(secondRun.inutilizedDocumentIds).not.toContain(draft.fiscal_document_id);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Cancelamento e CCe (RNF-FIS-062)
  // ───────────────────────────────────────────────────────────────────────
  describe('RNF-FIS-062 — cancelamento e CCe', () => {
    async function authorizeFreshDocument(qty: number) {
      const product = await createProduct();
      await seedStorageInvoiceWithBalance(product.id, qty + 50);
      const order = await seedOutboundOrderReadyForFiscal(product.id, qty);
      const draft = await dispatchService.confirmFiscalDocuments(order.id, clientId, warehouseId, SEED_ACTOR_ID);
      const authorized = await fiscalEmissionService.processDocument(draft.fiscal_document_id, clientId, warehouseId);
      expect(authorized.outcome).toBe('AUTHORIZED');
      return { fiscalDocumentId: draft.fiscal_document_id, order, product };
    }

    async function approveCancellationException(entityId: string) {
      const exception = await operationalExceptionService.create({
        tenantId: clientId,
        exceptionType: 'FIS.CANCELAMENTO_NFE',
        warehouseId,
        entity: 'fiscal_document',
        entityId,
        reasonRequest: 'Teste de cancelamento 8B',
        requestedBy: solicitante.id,
      });
      await operationalExceptionService.decide(exception.id, clientId, warehouseId, aprovador1.id, 'APPROVE', 'Passo 1 ok');
      return operationalExceptionService.decide(exception.id, clientId, warehouseId, aprovador2.id, 'APPROVE', 'Passo 2 ok');
    }

    it('cancela dentro do prazo: estorna o Consumo Fiscal e grava evento CANCELAMENTO', async () => {
      const { fiscalDocumentId } = await authorizeFreshDocument(30);
      const approved = await approveCancellationException(fiscalDocumentId);

      const cancelled = await storageReturnInvoiceService.cancel({
        fiscalDocumentId,
        tenantId: clientId,
        warehouseId,
        reason: 'Erro de digitação na quantidade',
        exceptionId: approved.id,
        actorUserId: SEED_ACTOR_ID,
      });
      expect(cancelled.status).toBe('CANCELLED');

      const eventResult = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.fiscal_document_event WHERE fiscal_document_id = $1 AND event_type = 'CANCELAMENTO'`,
        [fiscalDocumentId]
      );
      expect(eventResult.rows.length).toBe(1);

      const allocationResult = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT status FROM wms.fiscal_allocation WHERE return_fiscal_document_id = $1`,
        [fiscalDocumentId]
      );
      expect(allocationResult.rows.length).toBeGreaterThan(0);
      expect(allocationResult.rows.every((r: any) => r.status === 'ESTORNADA')).toBe(true);
    });

    it('bloqueia cancelamento quando o pedido já está GATE_OUT', async () => {
      const { fiscalDocumentId, order } = await authorizeFreshDocument(15);
      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `UPDATE wms.outbound_order SET status = 'GATE_OUT' WHERE id = $1`,
        [order.id]
      );
      const approved = await approveCancellationException(fiscalDocumentId);

      await expect(
        storageReturnInvoiceService.cancel({
          fiscalDocumentId,
          tenantId: clientId,
          warehouseId,
          reason: 'Tentativa após GATE_OUT',
          exceptionId: approved.id,
          actorUserId: SEED_ACTOR_ID,
        })
      ).rejects.toMatchObject({ response: { error: 'FISCAL_CANCELLATION_BLOCKED_CIRCULATION' } });
    });

    it('CCe: aceita até 20 eventos por nota; o 21º é rejeitado', async () => {
      const { fiscalDocumentId } = await authorizeFreshDocument(10);

      for (let i = 1; i <= 20; i++) {
        const event = await storageReturnInvoiceService.registerCce(fiscalDocumentId, clientId, warehouseId, `Correção número ${i}`, SEED_ACTOR_ID);
        expect(event.sequence_number).toBe(i);
      }

      await expect(storageReturnInvoiceService.registerCce(fiscalDocumentId, clientId, warehouseId, 'Correção 21', SEED_ACTOR_ID)).rejects.toMatchObject({
        response: { error: 'FISCAL_CCE_LIMIT_EXCEEDED' },
      });
    });
  });
});

/** Gera um PFX (PKCS12) autoassinado em memória — só para os testes, nunca um certificado real. */
function generateSelfSignedPfx(password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: 'Teste Fiscal 8B' }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(p12Der, 'binary');
}
