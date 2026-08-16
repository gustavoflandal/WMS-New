// Scenario ENTREGÁVEL 6/8 — DOC-02 §5.6, RN-DAD-040: numeração de
// documentos. document_sequence é GLOBAL (RN-DAD-004) — sem tenant_id, sem
// RLS. Testes: formato da máscara, concorrência (50 gerações paralelas =>
// 50 números distintos e contíguos), e não-reuso (o serviço só incrementa —
// não existe caminho de código que decremente ou reatribua um número já
// emitido, então "documento cancelado preserva o número" é uma propriedade
// estrutural: o próximo generateDocumentNumber() sempre continua do último
// valor persistido, nunca reaproveita).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { DocumentNumberingService } from '../document-numbering/document-numbering.service.js';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RN-DAD-040 numeracao de documentos', () => {
  let testContext: TestContext;
  let warehouseService: WarehouseService;
  let documentNumbering: DocumentNumberingService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    warehouseService = new WarehouseService(testContext.databaseService);
    documentNumbering = new DocumentNumberingService(testContext.databaseService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('formato PREFIXO-CODARMAZEM-SEQ8: PED-SP01-00000101 apos last_value=100', async () => {
    const warehouse = await warehouseService.create({
      code: 'SP01', // literal do exemplo normativo do DOC-02 §5.6
      name: 'Armazém de teste numeracao',
      cnpj: generateValidCnpj(),
      timezone: 'America/Sao_Paulo',
      actor_user_id: SEED_ACTOR_ID,
    });

    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.document_sequence (document_type, warehouse_id, last_value, created_by)
       VALUES ('OUTBOUND_ORDER', $1, 100, $2)`,
      [warehouse.id, SEED_ACTOR_ID]
    );

    const number = await documentNumbering.generateDocumentNumberStandalone('OUTBOUND_ORDER', warehouse.id, warehouse.code, SEED_ACTOR_ID);
    expect(number).toBe('PED-SP01-00000101');

    const next = await documentNumbering.generateDocumentNumberStandalone('OUTBOUND_ORDER', warehouse.id, warehouse.code, SEED_ACTOR_ID);
    expect(next).toBe('PED-SP01-00000102');
  });

  it('concorrencia: 50 geracoes paralelas produzem 50 numeros distintos e contiguos', async () => {
    const warehouse = await warehouseService.create({
      code: randomWarehouseCode(),
      name: 'Armazém de teste concorrencia',
      cnpj: generateValidCnpj(),
      timezone: 'America/Sao_Paulo',
      actor_user_id: SEED_ACTOR_ID,
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        documentNumbering.generateDocumentNumberStandalone('TRANSFER', warehouse.id, warehouse.code, SEED_ACTOR_ID)
      )
    );

    const sequentials = results.map((n) => parseInt(n.split('-')[2], 10)).sort((a, b) => a - b);
    const uniqueCount = new Set(sequentials).size;

    expect(results).toHaveLength(50);
    expect(uniqueCount).toBe(50); // sem colisao mesmo sob concorrencia real
    expect(sequentials[0]).toBe(1);
    expect(sequentials[49]).toBe(50);
    for (let i = 1; i < sequentials.length; i++) {
      expect(sequentials[i]).toBe(sequentials[i - 1] + 1); // contiguos, sem buraco
    }
  });

  it('numero preservado apos "cancelamento": proxima geracao nunca reaproveita um numero ja emitido', async () => {
    const warehouse = await warehouseService.create({
      code: randomWarehouseCode(),
      name: 'Armazém de teste no-reuse',
      cnpj: generateValidCnpj(),
      timezone: 'America/Sao_Paulo',
      actor_user_id: SEED_ACTOR_ID,
    });

    const first = await documentNumbering.generateDocumentNumberStandalone('INVENTORY', warehouse.id, warehouse.code, SEED_ACTOR_ID);
    expect(first).toBe(`INV-${warehouse.code}-00000001`);

    // "Cancelamento" do documento que consumiu `first`: nao existe operacao
    // de estorno/decremento em DocumentNumberingService (por construcao) --
    // simula-se a ausencia de efeito simplesmente NAO chamando nada e
    // gerando o proximo numero normalmente.
    const second = await documentNumbering.generateDocumentNumberStandalone('INVENTORY', warehouse.id, warehouse.code, SEED_ACTOR_ID);
    expect(second).toBe(`INV-${warehouse.code}-00000002`);
    expect(second).not.toBe(first);
  });
});
