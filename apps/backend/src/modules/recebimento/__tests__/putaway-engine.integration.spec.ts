// DOC-04 §4.5/§6 — Motor de Putaway contra Postgres real.
// Cobre os 2 cenários Gherkin de putaway do §6 (Fase 1 não admite override;
// ranqueamento determinístico E2/E1/E3) e os filtros invioláveis exigidos
// pela sessão: RG-015 (contenção de armazém lógico), capacidade sobre
// ocupação atual, LIFO_PHYSICAL com canal homogêneo e quarentena.
//
// `wms.app_parameter` é limpo entre arquivos de teste por cleanTestData() —
// REC.CRITERIOS_PUTAWAY é inserido no fixture, nunca herdado do seed.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { LogicalWarehouseService } from '../../cadastro/logical-warehouse/logical-warehouse.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PutawayEngineService } from '../putaway/putaway-engine.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Recebimento - DOC-04 §4.5/§6 Motor de Putaway (RN-REC-040)', () => {
  let testContext: TestContext;
  let engine: PutawayEngineService;
  let productService: ProductService;
  let batchService: BatchService;
  let zoneService: ZoneService;
  let palletService: PalletService;
  let logicalWarehouseService: LogicalWarehouseService;
  let clientService: ClientService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;
  let prefZoneId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    engine = new PutawayEngineService(db);
    productService = new ProductService(db, auditService);
    batchService = new BatchService(db, auditService);
    zoneService = new ZoneService(db, auditService);
    clientService = new ClientService(db, auditService);
    logicalWarehouseService = new LogicalWarehouseService(db, auditService);
    palletService = new PalletService(db, new LpnService(new DocumentNumberingService(db)));

    const warehouseService = new WarehouseService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém putaway', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente putaway', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    // GS1_PREFIX próprio (ver débito LpnService/DEFAULT_GS1_PREFIX no
    // relatório da Sessão 4A — armazéns sem prefixo colidem em pallet_lpn_unique).
    await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7420001', $1)`,
      [warehouseId]
    );

    const storage = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    storageZoneId = storage.id;
    const pref = await zoneService.create({ warehouse_id: warehouseId, code: 'PRF', name: 'Preferencial', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    prefZoneId = pref.id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /** Insere endereço por SQL direto: LocationService não expõe abc_class, que os testes de ranqueamento exigem. */
  async function createLocation(opts: {
    zoneId: string;
    aisle: string;
    module: string;
    level: string;
    slot: string;
    abcClass?: string | null;
    maxWeightKg?: number;
    maxVolumeM3?: number;
    maxPallets?: number;
    maxHeightM?: number;
    storageEquipmentId?: string | null;
    status?: string;
    locationType?: string;
  }) {
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, storage_equipment_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, abc_class, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        warehouseId,
        opts.zoneId,
        opts.storageEquipmentId ?? null,
        opts.aisle,
        opts.module,
        opts.level,
        opts.slot,
        opts.locationType ?? 'STORAGE',
        opts.maxWeightKg ?? 2000,
        opts.maxVolumeM3 ?? 50,
        opts.maxPallets ?? 2,
        opts.maxHeightM ?? 5,
        opts.abcClass ?? null,
        opts.status ?? 'ACTIVE',
        SEED_ACTOR_ID,
      ]
    );
    return result.rows[0];
  }

  /** Cria um palete com 1 linha de conteúdo. Produto leve/pequeno por padrão para não esbarrar em capacidade. */
  async function createPallet(opts: { speciesCode?: string; giroPolicy?: string | null; qty?: number; batchCode?: string | null; batchStatus?: string; heightM?: number; weightKg?: number }) {
    const product = await productService.create(
      {
        tenant_id: clientId,
        sku: randomSku(),
        description: `Produto ${opts.speciesCode ?? 'GERAL'}`,
        species_code: opts.speciesCode ?? 'GERAL',
        base_uom: 'UN',
        giro_policy: opts.giroPolicy ?? undefined,
        gross_weight_kg: opts.weightKg ?? 1,
        length_m: 0.1,
        width_m: 0.1,
        height_m: opts.heightM ?? 0.1,
      },
      SEED_ACTOR_ID
    );

    let batchId: string | null = null;
    if (opts.batchCode) {
      const batch = await batchService.create(
        { tenant_id: clientId, product_id: product.id, batch_code: opts.batchCode, manufacture_date: '2026-01-01', expiration_date: '2027-01-01' },
        SEED_ACTOR_ID
      );
      batchId = batch.id;
      if (opts.batchStatus && opts.batchStatus !== 'RELEASED') {
        await batchService.update(batch.id, clientId, warehouseId, { status: opts.batchStatus as 'QUARANTINE' }, SEED_ACTOR_ID);
      }
    }

    const pallet = await palletService.create({ tenant_id: clientId, warehouse_id: warehouseId, pallet_type: 'PBR' }, SEED_ACTOR_ID);
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.pallet_content (tenant_id, pallet_id, product_id, batch_id, qty, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, pallet.id, product.id, batchId, opts.qty ?? 10, SEED_ACTOR_ID]
    );
    return { pallet, product, batchId };
  }

  async function setCriteria(criteria: string[]) {
    // DELETE precisa de contexto de tenant: wms.app_parameter tem RLS
    // (migration 0004) e queryGlobal() apagaria 0 linhas em silêncio,
    // deixando o parâmetro antigo acumulado e o teste seguinte lendo a
    // configuração errada.
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await testContext.databaseService.query(ctx, `DELETE FROM wms.app_parameter WHERE name = 'REC.CRITERIOS_PUTAWAY'`);
    await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.CRITERIOS_PUTAWAY', $1)`,
      [JSON.stringify(criteria)]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // §6 — Ranqueamento determinístico (exemplo normativo RN-REC-040)
  // ═══════════════════════════════════════════════════════════════════════
  it('§6 EXEMPLO NORMATIVO: [ZONA_PREFERENCIAL_PRODUTO, CLASSE_ABC, MENOR_NIVEL] -> E2, E1, E3 (sugestao E2)', async () => {
    await setCriteria(['ZONA_PREFERENCIAL_PRODUTO', 'CLASSE_ABC', 'MENOR_NIVEL']);

    // E1 (zona pref., classe B, nível 03) / E2 (zona pref., classe A, nível 04) / E3 (outra zona, classe A, nível 00)
    const e1 = await createLocation({ zoneId: prefZoneId, aisle: 'E1', module: '001', level: '03', slot: '01', abcClass: 'B' });
    const e2 = await createLocation({ zoneId: prefZoneId, aisle: 'E2', module: '001', level: '04', slot: '01', abcClass: 'A' });
    const e3 = await createLocation({ zoneId: storageZoneId, aisle: 'E3', module: '001', level: '00', slot: '01', abcClass: 'A' });

    const { pallet, product } = await createPallet({});
    // Zona preferencial do produto (product_warehouse_parameter).
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_warehouse_parameter (tenant_id, product_id, warehouse_id, putaway_zone_preference, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [clientId, product.id, warehouseId, [prefZoneId], SEED_ACTOR_ID]
    );

    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);

    const orderedCodes = [result.suggestion!.code, ...result.alternatives.map((a) => a.code)];
    const indexOf = (id: string) => orderedCodes.indexOf(id);
    expect(result.suggestion!.locationId).toBe(e2.id);
    expect(indexOf(e2.code)).toBeLessThan(indexOf(e1.code));
    expect(indexOf(e1.code)).toBeLessThan(indexOf(e3.code));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // §6 — Fase 1 não admite override (produto INFLAMAVEL)
  // ═══════════════════════════════════════════════════════════════════════
  it('§6 FASE 1 SEM OVERRIDE: INFLAMAVEL em zona sem INFLAMAVEL em allowed_species e reprovado LEGAL (RG-005)', async () => {
    await setCriteria(['MENOR_NIVEL']);
    const semInflamavel = await createLocation({ zoneId: storageZoneId, aisle: 'F1', module: '001', level: '00', slot: '01' });

    const { pallet } = await createPallet({ speciesCode: 'INFLAMAVEL', batchCode: 'LOTE-INFLAM-01' });

    const verdict = await engine.evaluateSingleLocation(pallet.id, semInflamavel.id, clientId, warehouseId, SEED_ACTOR_ID);
    // REJECTED_LEGAL é o veredito que NENHUM override supera (RN-REC-040 +
    // RG-005: "incompatibilidades legais NÃO admitem override por nenhum papel").
    expect(verdict.verdict).toBe('REJECTED_LEGAL');
    expect(verdict.failedFilter).toBe(3);

    // E o motor também não o sugere.
    const suggestion = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(suggestion.rejected.some((r) => r.locationId === semInflamavel.id && r.verdict === 'REJECTED_LEGAL')).toBe(true);
    expect(suggestion.alternatives.map((a) => a.locationId)).not.toContain(semInflamavel.id);
    expect(suggestion.suggestion?.locationId).not.toBe(semInflamavel.id);
  });

  it('INFLAMAVEL em zona CLASSIFIED_FLAMMABLE com allowed_species correto e APROVADO', async () => {
    await setCriteria([]);
    const flamZone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'FLM', name: 'Inflamáveis', zone_type: 'CLASSIFIED_FLAMMABLE', allowed_species: ['INFLAMAVEL'] },
      SEED_ACTOR_ID
    );
    const flamLoc = await createLocation({ zoneId: flamZone.id, aisle: 'F2', module: '001', level: '00', slot: '01' });

    const { pallet } = await createPallet({ speciesCode: 'INFLAMAVEL', batchCode: 'LOTE-INFLAM-02' });
    const verdict = await engine.evaluateSingleLocation(pallet.id, flamLoc.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(verdict.verdict).toBe('APPROVED');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // RG-015 — contenção do Armazém Lógico (cross-tenant)
  // ═══════════════════════════════════════════════════════════════════════
  it('RG-015: endereco do armazem logico do cliente B nao e sugerido para o cliente A, e o override NAO vence', async () => {
    await setCriteria([]);
    const livre = await createLocation({ zoneId: storageZoneId, aisle: 'G1', module: '001', level: '00', slot: '01' });
    const doClienteB = await createLocation({ zoneId: storageZoneId, aisle: 'G2', module: '001', level: '00', slot: '01' });

    const clientB = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente B RG-015', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    const lwB = await logicalWarehouseService.create(
      { tenant_id: clientB.id, warehouse_id: warehouseId, code: 'LWB', name: 'Armazém lógico do B' },
      SEED_ACTOR_ID
    );
    await logicalWarehouseService.link(lwB.id, doClienteB.id, clientB.id, SEED_ACTOR_ID);

    const { pallet } = await createPallet({});
    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);

    // Não sugerido nem alternativo...
    const offered = [result.suggestion?.locationId, ...result.alternatives.map((a) => a.locationId)];
    expect(offered).not.toContain(doClienteB.id);
    // ...e reprovado com o motivo EXATO de RG-015 item 2.
    const rejection = result.rejected.find((r) => r.locationId === doClienteB.id);
    expect(rejection?.verdict).toBe('REJECTED_LEGAL');
    expect(rejection?.failedFilter).toBe(2);
    expect(rejection?.reason).toMatch(/RG-015 item 2/);

    // O endereço livre continua disponível (a contenção não vaza para os demais).
    expect(offered).toContain(livre.id);

    // Override não vence: a avaliação direta do endereço segue REJECTED_LEGAL.
    const verdict = await engine.evaluateSingleLocation(pallet.id, doClienteB.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(verdict.verdict).toBe('REJECTED_LEGAL');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Filtro 5 — capacidade sobre a ocupação ATUAL
  // ═══════════════════════════════════════════════════════════════════════
  it('capacidade: endereco cuja OCUPACAO atual nao comporta o palete e filtrado (nao a capacidade nominal vazia)', async () => {
    await setCriteria([]);
    // Comporta 1 palete; já vamos ocupar com um saldo existente.
    const quaseCheio = await createLocation({ zoneId: storageZoneId, aisle: 'H1', module: '001', level: '00', slot: '01', maxPallets: 1 });
    const vago = await createLocation({ zoneId: storageZoneId, aisle: 'H2', module: '001', level: '00', slot: '01', maxPallets: 1 });

    // Ocupa `quaseCheio` com um palete real (mesma classe NEUTRA para não
    // esbarrar em RN-EST-022 antes de chegar ao filtro 5).
    const ocupante = await createPallet({});
    // RN-EST-001 (migration 0045): stock_balance só aceita escrita autorizada
    // pelo StockMovementService — fixture crua precisa "assinar" a mesma
    // session var que o serviço usa, dentro de uma transação.
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
      await client.query(
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, pallet_id, qty_available, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [clientId, warehouseId, ocupante.product.id, quaseCheio.id, ocupante.pallet.id, 10, SEED_ACTOR_ID]
      );
    });

    const { pallet } = await createPallet({});
    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);

    const rejection = result.rejected.find((r) => r.locationId === quaseCheio.id);
    expect(rejection?.failedFilter).toBe(5);
    expect(rejection?.reason).toMatch(/vaga de palete/);

    // O endereço cheio nunca é ofertado...
    const offered = [result.suggestion?.locationId, ...result.alternatives.map((a) => a.locationId)];
    expect(offered).not.toContain(quaseCheio.id);
    // ...e o de mesma capacidade nominal, porém VAGO, passa na Fase 1 (a
    // diferença entre os dois é exclusivamente a ocupação atual). Verificado
    // por avaliação direta, não pela lista ofertada: esta suíte já criou
    // vários endereços aprovados e só os 5 primeiros são devolvidos.
    const vagoVerdict = await engine.evaluateSingleLocation(pallet.id, vago.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(vagoVerdict.verdict).toBe('APPROVED');
  });

  it('capacidade: palete mais pesado que a capacidade RESTANTE do endereco e filtrado', async () => {
    await setCriteria([]);
    const leve = await createLocation({ zoneId: storageZoneId, aisle: 'H3', module: '001', level: '00', slot: '01', maxWeightKg: 50, maxPallets: 5 });

    const { pallet } = await createPallet({ qty: 100, weightKg: 1 }); // 100 kg > 50 kg
    const verdict = await engine.evaluateSingleLocation(pallet.id, leve.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(verdict.verdict).toBe('REJECTED_LEGAL');
    expect(verdict.failedFilter).toBe(5);
    expect(verdict.reason).toMatch(/peso máximo/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Filtro 6 — LIFO_PHYSICAL exige canal de lote homogêneo
  // ═══════════════════════════════════════════════════════════════════════
  it('LIFO_PHYSICAL: produto FEFO so entra em canal de lote HOMOGENEO (RN-DAD-010)', async () => {
    await setCriteria([]);
    const driveIn = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by) VALUES ($1,'DRV-01','DRIVE_IN',$2) RETURNING *`,
      [warehouseId, SEED_ACTOR_ID]
    );
    expect(driveIn.rows[0].access_policy).toBe('LIFO_PHYSICAL');

    // Zona DEDICADA: a zona compartilhada já acumulou saldo da classe NEUTRA
    // em testes anteriores, e a matriz RN-EST-021 (NEUTRA na zona x ALIMENTAR
    // entrando = 'O') reprovaria no filtro 3 ANTES de o filtro 6 ser
    // alcançado — o motor está certo, o fixture é que precisa isolar o
    // filtro sob teste.
    const canalZone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'CNL', name: 'Canal drive-in', zone_type: 'STORAGE', allowed_species: ['ALIMENTO'] },
      SEED_ACTOR_ID
    );

    // Mesmo canal = mesmo equipamento + aisle + module + level (slots 01 e 02).
    const canalSlot1 = await createLocation({ zoneId: canalZone.id, aisle: 'I1', module: '001', level: '00', slot: '01', storageEquipmentId: driveIn.rows[0].id, maxPallets: 5 });
    const canalSlot2 = await createLocation({ zoneId: canalZone.id, aisle: 'I1', module: '001', level: '00', slot: '02', storageEquipmentId: driveIn.rows[0].id, maxPallets: 5 });

    // Canal já tem o LOTE-A ocupando o slot 01.
    const ocupante = await createPallet({ speciesCode: 'ALIMENTO', giroPolicy: 'FEFO', batchCode: 'LOTE-CANAL-A' });
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
      await client.query(
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, batch_id, location_id, pallet_id, qty_available, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [clientId, warehouseId, ocupante.product.id, ocupante.batchId, canalSlot1.id, ocupante.pallet.id, 10, SEED_ACTOR_ID]
      );
    });

    // Palete FEFO de lote DIFERENTE -> reprovado no filtro 6 nos dois slots do canal.
    const outroLote = await createPallet({ speciesCode: 'ALIMENTO', giroPolicy: 'FEFO', batchCode: 'LOTE-CANAL-B' });
    const vSlot2 = await engine.evaluateSingleLocation(outroLote.pallet.id, canalSlot2.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(vSlot2.verdict).toBe('REJECTED_LEGAL');
    expect(vSlot2.failedFilter).toBe(6);
    expect(vSlot2.reason).toMatch(/LIFO_PHYSICAL/);

    // Palete FEFO do MESMO lote -> aprovado (canal homogêneo).
    const mesmoLote = await palletService.create({ tenant_id: clientId, warehouse_id: warehouseId, pallet_type: 'PBR' }, SEED_ACTOR_ID);
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.pallet_content (tenant_id, pallet_id, product_id, batch_id, qty, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, mesmoLote.id, ocupante.product.id, ocupante.batchId, 5, SEED_ACTOR_ID]
    );
    const vHomogeneo = await engine.evaluateSingleLocation(mesmoLote.id, canalSlot2.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(vHomogeneo.verdict).toBe('APPROVED');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Filtro 4 — quarentena (RN-REC-031)
  // ═══════════════════════════════════════════════════════════════════════
  it('quarentena: lote QUARANTINE so recebe sugestao de zona QUARANTINE', async () => {
    await setCriteria([]);
    const quarantineZone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'QUA', name: 'Quarentena', zone_type: 'QUARANTINE', allowed_species: ['MEDICAMENTO'] },
      SEED_ACTOR_ID
    );
    const quarantineLoc = await createLocation({ zoneId: quarantineZone.id, aisle: 'J1', module: '001', level: '00', slot: '01', locationType: 'QUARANTINE' });
    const storageLoc = await createLocation({ zoneId: storageZoneId, aisle: 'J2', module: '001', level: '00', slot: '01' });

    const { pallet } = await createPallet({ speciesCode: 'MEDICAMENTO', batchCode: 'LOTE-MED-QUAR', batchStatus: 'QUARANTINE' });

    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);

    // TODA sugestão/alternativa está em zona QUARANTINE.
    const offered = [result.suggestion?.locationId, ...result.alternatives.map((a) => a.locationId)].filter(Boolean);
    expect(offered).toContain(quarantineLoc.id);
    expect(offered).not.toContain(storageLoc.id);

    // O endereço de STORAGE foi reprovado — por MEDICAMENTO (filtro 3) ou por
    // quarentena (filtro 4); ambos são reprovação LEGAL da Fase 1.
    const rejection = result.rejected.find((r) => r.locationId === storageLoc.id);
    expect(rejection?.verdict).toBe('REJECTED_LEGAL');
    expect([3, 4]).toContain(rejection?.failedFilter);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // RN-DAD-010 (metade preferencial) — desempate técnico por rotação física
  // ═══════════════════════════════════════════════════════════════════════
  it('RN-DAD-010: produto FEFO empatado nos criterios vai para o FLOWRACK (FIFO_PHYSICAL), nao para o porta-paletes (RANDOM)', async () => {
    // Zona dedicada + zona preferencial do produto isolam os dois endereços
    // no topo do ranking; o desempate técnico decide entre eles.
    const rotZone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'ROT', name: 'Rotação', zone_type: 'STORAGE', allowed_species: ['ALIMENTO'] },
      SEED_ACTOR_ID
    );

    const flowrack = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by) VALUES ($1,'FLW-01','FLOWRACK',$2) RETURNING *`,
      [warehouseId, SEED_ACTOR_ID]
    );
    const portaPaletes = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by) VALUES ($1,'PPT-01','PORTA_PALETES',$2) RETURNING *`,
      [warehouseId, SEED_ACTOR_ID]
    );
    expect(flowrack.rows[0].access_policy).toBe('FIFO_PHYSICAL');
    expect(portaPaletes.rows[0].access_policy).toBe('RANDOM');

    // Códigos deliberadamente invertidos: o porta-paletes tem o MENOR código,
    // então sem o desempate técnico ele venceria pelo desempate final.
    const locPorta = await createLocation({ zoneId: rotZone.id, aisle: 'K1', module: '001', level: '00', slot: '01', storageEquipmentId: portaPaletes.rows[0].id });
    const locFlow = await createLocation({ zoneId: rotZone.id, aisle: 'K2', module: '001', level: '00', slot: '01', storageEquipmentId: flowrack.rows[0].id });
    expect(locPorta.code < locFlow.code).toBe(true);

    await setCriteria(['ZONA_PREFERENCIAL_PRODUTO']);
    const { pallet, product } = await createPallet({ speciesCode: 'ALIMENTO', giroPolicy: 'FEFO', batchCode: 'LOTE-ROT-FEFO' });
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_warehouse_parameter (tenant_id, product_id, warehouse_id, putaway_zone_preference, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [clientId, product.id, warehouseId, [rotZone.id], SEED_ACTOR_ID]
    );

    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(result.suggestion!.locationId).toBe(locFlow.id);
    expect(result.alternatives[0].locationId).toBe(locPorta.id);
  });

  it('RN-DAD-010: produto LIFO nao aplica o desempate — vence o menor location.code', async () => {
    const rotZone = await zoneService.create(
      { warehouse_id: warehouseId, code: 'RT2', name: 'Rotação LIFO', zone_type: 'STORAGE', allowed_species: ['ALIMENTO'] },
      SEED_ACTOR_ID
    );
    const flowrack = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by) VALUES ($1,'FLW-02','FLOWRACK',$2) RETURNING *`,
      [warehouseId, SEED_ACTOR_ID]
    );
    const portaPaletes = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.storage_equipment (warehouse_id, code, equipment_type, created_by) VALUES ($1,'PPT-02','PORTA_PALETES',$2) RETURNING *`,
      [warehouseId, SEED_ACTOR_ID]
    );
    const locPorta = await createLocation({ zoneId: rotZone.id, aisle: 'L1', module: '001', level: '00', slot: '01', storageEquipmentId: portaPaletes.rows[0].id });
    const locFlow = await createLocation({ zoneId: rotZone.id, aisle: 'L2', module: '001', level: '00', slot: '01', storageEquipmentId: flowrack.rows[0].id });

    await setCriteria(['ZONA_PREFERENCIAL_PRODUTO']);
    const { pallet, product } = await createPallet({ speciesCode: 'ALIMENTO', giroPolicy: 'LIFO', batchCode: 'LOTE-ROT-LIFO' });
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_warehouse_parameter (tenant_id, product_id, warehouse_id, putaway_zone_preference, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [clientId, product.id, warehouseId, [rotZone.id], SEED_ACTOR_ID]
    );

    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(result.suggestion!.locationId).toBe(locPorta.id); // menor code
    expect(locPorta.code < locFlow.code).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Catálogo FECHADO da Fase 2
  // ═══════════════════════════════════════════════════════════════════════
  it('REC.CRITERIOS_PUTAWAY com criterio fora do catalogo fechado e erro determinístico', async () => {
    await setCriteria(['ZONA_PREFERENCIAL_PRODUTO', 'CRITERIO_INVENTADO']);
    const { pallet } = await createPallet({});
    await expect(engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'INVALID_PUTAWAY_CRITERIA' },
    });
    await setCriteria([]);
  });

  it('nenhum endereco aprovado: sugestao nula e diagnostico com o motivo de CADA reprovacao', async () => {
    await setCriteria([]);
    // Espécie QUIMICO_CONTROLADO exige zona CONTROLLED, que este armazém não tem.
    const { pallet } = await createPallet({ speciesCode: 'QUIMICO_CONTROLADO', batchCode: 'LOTE-QUIM-01' });
    const result = await engine.suggestLocations(pallet.id, clientId, warehouseId, SEED_ACTOR_ID);

    expect(result.suggestion).toBeNull();
    expect(result.alternatives).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
    // Motivo EXATO por endereço: filtro + código do endereço.
    for (const rejection of result.rejected) {
      expect(rejection.reason).toContain(rejection.code);
      expect(rejection.failedFilter).toBeGreaterThanOrEqual(1);
      expect(rejection.failedFilter).toBeLessThanOrEqual(6);
    }
  });
});
