// Scenario ENTREGÁVEL 5 (6/6): enum inválido é rejeitado pelo CHECK do banco
// (RN-DAD-005: enums como TEXT + CHECK com os valores exatos do documento).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { BadRequestException } from '@nestjs/common';
import { generateValidCnpj, randomWarehouseCode, SEED_ACTOR_ID } from './test-helpers.js';

describe('Cadastro - RN-DAD-005 enum inválido rejeitado pelo CHECK', () => {
  let testContext: TestContext;
  let warehouseService: WarehouseService;
  let zoneService: ZoneService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    warehouseService = new WarehouseService(testContext.databaseService, auditService);
    zoneService = new ZoneService(testContext.databaseService, auditService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('zone_type fora da lista do DOC-02 é rejeitado (mapeado para 400)', async () => {
    const warehouse = await warehouseService.create(
      {
        code: randomWarehouseCode(),
        name: 'Armazém de teste enum inválido',
        cnpj: generateValidCnpj(),
        timezone: 'America/Sao_Paulo',
      },
      SEED_ACTOR_ID
    );

    await expect(
      zoneService.create(
        {
          warehouse_id: warehouse.id,
          code: 'INV',
          name: 'Zona inválida',
          zone_type: 'NAO_EXISTE_NO_DOC_02',
        },
        SEED_ACTOR_ID
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
