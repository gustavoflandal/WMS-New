// Scenario ENTREGÁVEL 8 / RN-DAD-030: geração de LPN via pipeline completo
// (document_sequence + Mod-10 GS1), incluindo o exemplo normativo do DOC-02
// §7 (extensão 1, prefixo 2900000, sequencial 000001234 -> LPN
// 129000000000012346) e unicidade global.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ClientService } from '../client/client.service.js';
import { LpnService } from '../lpn/lpn.service.js';
import { DocumentNumberingService } from '../document-numbering/document-numbering.service.js';
import { PalletService } from '../pallet/pallet.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RN-DAD-030 geracao de LPN (SSCC)', () => {
  let testContext: TestContext;
  let warehouseService: WarehouseService;
  let clientService: ClientService;
  let palletService: PalletService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    clientService = new ClientService(testContext.databaseService, auditService);
    const documentNumbering = new DocumentNumberingService(testContext.databaseService);
    const lpnService = new LpnService(documentNumbering);
    palletService = new PalletService(testContext.databaseService, lpnService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('exemplo normativo: sequencial 1234 no armazem sem prefixo proprio -> LPN 129000000000012346', async () => {
    const warehouse = await warehouseService.create(
      {
        code: randomWarehouseCode(),
        name: 'Armazém de teste LPN normativo',
        cnpj: generateValidCnpj(),
        timezone: 'America/Sao_Paulo',
      },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      {
        code: 'LPNCLI',
        legal_name: 'Cliente LPN Ltda',
        cnpj: generateValidCnpj(),
      },
      SEED_ACTOR_ID
    );

    // Forca o sequencial de LPN deste armazem para 1233, para que o proximo
    // gerado seja exatamente 1234 (exemplo normativo do DOC-02 §7).
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.document_sequence (document_type, warehouse_id, last_value, created_by)
       VALUES ('LPN', $1, 1233, $2)`,
      [warehouse.id, SEED_ACTOR_ID]
    );

    const pallet = await palletService.create(
      {
        tenant_id: client.id,
        warehouse_id: warehouse.id,
        pallet_type: 'PBR',
      },
      SEED_ACTOR_ID
    );

    expect(pallet.lpn).toBe('129000000000012346');
  });

  it('LPN e unico globalmente (segundo palete recebe sequencial diferente)', async () => {
    const warehouse = await warehouseService.create(
      {
        code: randomWarehouseCode(),
        name: 'Armazém de teste LPN unicidade',
        cnpj: generateValidCnpj(),
        timezone: 'America/Sao_Paulo',
      },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      {
        code: 'LPNUNQ',
        legal_name: 'Cliente LPN Unicidade Ltda',
        cnpj: generateValidCnpj(),
      },
      SEED_ACTOR_ID
    );

    const pallet1 = await palletService.create(
      { tenant_id: client.id, warehouse_id: warehouse.id, pallet_type: 'PBR' },
      SEED_ACTOR_ID
    );
    const pallet2 = await palletService.create(
      { tenant_id: client.id, warehouse_id: warehouse.id, pallet_type: 'PBR' },
      SEED_ACTOR_ID
    );

    expect(pallet1.lpn).not.toBe(pallet2.lpn);
    expect(pallet1.lpn).toMatch(/^[0-9]{18}$/);
    expect(pallet2.lpn).toMatch(/^[0-9]{18}$/);

    // UNIQUE(lpn) do banco rejeita insercao direta de LPN duplicado.
    await expect(
      testContext.databaseService.query(
        { tenant_id: client.id, user_id: SEED_ACTOR_ID },
        `INSERT INTO wms.pallet (tenant_id, lpn, pallet_type, created_by) VALUES ($1, $2, 'PBR', $3)`,
        [client.id, pallet1.lpn, SEED_ACTOR_ID]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('usa GS1_PREFIX proprio do armazem quando configurado em app_parameter', async () => {
    const warehouse = await warehouseService.create(
      {
        code: randomWarehouseCode(),
        name: 'Armazém de teste GS1 proprio',
        cnpj: generateValidCnpj(),
        timezone: 'America/Sao_Paulo',
      },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      {
        code: 'LPNGS1',
        legal_name: 'Cliente LPN GS1 Ltda',
        cnpj: generateValidCnpj(),
      },
      SEED_ACTOR_ID
    );

    // app_parameter tem RLS mesmo para linhas WAREHOUSE (migration 0004) --
    // precisa de app.warehouse_id setado no contexto para passar o WITH
    // CHECK da policy, mesmo sendo dado conceitualmente GLOBAL/WAREHOUSE.
    await testContext.databaseService.query(
      { tenant_id: SEED_ACTOR_ID, user_id: SEED_ACTOR_ID, warehouse_id: warehouse.id },
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7891234', $1)`,
      [warehouse.id]
    );
    await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.document_sequence (document_type, warehouse_id, last_value, created_by)
       VALUES ('LPN', $1, 0, $2)`,
      [warehouse.id, SEED_ACTOR_ID]
    );

    const pallet = await palletService.create(
      { tenant_id: client.id, warehouse_id: warehouse.id, pallet_type: 'PBR' },
      SEED_ACTOR_ID
    );

    expect(pallet.lpn.startsWith('17891234')).toBe(true);
  });
});
