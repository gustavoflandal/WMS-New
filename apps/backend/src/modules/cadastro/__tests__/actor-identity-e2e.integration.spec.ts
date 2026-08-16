// DOC-12 RG-003 [INVIOLÁVEL] — teste de regressão que impede a volta da
// vulnerabilidade de falsificação de identidade encontrada nesta sessão:
// os 13 controllers de cadastro aceitavam `actor_user_id` do body/query do
// cliente e o gravavam em created_by/updated_by/audit_log.user_id, sem
// derivar do JWT autenticado. A correção foi:
//   1. Middleware global (reject-actor-spoofing.middleware.ts) que REJEITA
//      (400), não ignora, qualquer requisição com actor_user_id/user_id em
//      body ou query.
//   2. Todos os controllers passaram a usar @CurrentUser() (populado por
//      PermissionGuard a partir do JWT) como única fonte do ator.
//   3. @Audited()/AuditInterceptor + chamadas explícitas a
//      AuditService.record() nos services cobrem CREATE/UPDATE/STATUS_CHANGE.
//
// Este teste sobe uma aplicação HTTP real (não chama os services
// diretamente) porque o middleware só participa do pipeline real de
// requisição — testar via chamada direta ao service, como os demais testes
// de integração deste diretório fazem, não exercitaria o próprio bug
// original (que vivia exatamente no boundary HTTP).
import { Test } from '@nestjs/testing';
import { INestApplication, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AddressInfo } from 'net';
import { DatabaseModule } from '../../../core/database/database.module.js';
import { RbacModule } from '../../../core/rbac/rbac.module.js';
import { AuthModule } from '../../../core/auth/auth.module.js';
import { AuditModule } from '../../../core/audit/audit.module.js';
import { CadastroModule } from '../cadastro.module.js';
import { rejectActorSpoofingMiddleware } from '../../../core/rbac/middleware/reject-actor-spoofing.middleware.js';
import { AuthService } from '../../../core/auth/auth.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { DatabaseService } from '../../../core/database/database.service.js';
import { WarehouseService } from '../warehouse/warehouse.service.js';
import { ClientService } from '../client/client.service.js';
import { ProductService } from '../product/product.service.js';
import { ZoneService } from '../zone/zone.service.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku } from './test-helpers.js';

if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-actor-identity-e2e';

// Papel de teste dedicado (não um dos 13 papéis semente) com TODAS as
// permissões WAREHOUSE/CLIENT_WAREHOUSE de cadastro, para varrer as rotas
// de escrita em uma única atribuição — nenhuma delas é GLOBAL, então o
// login não exige MFA (RF-SEG-005).
const SWEEP_ROLE_CODE = 'TEST_CADASTRO_SWEEP';
const SWEEP_PERMISSIONS = [
  'DAD.PHYSICAL_STRUCTURE_MANAGE',
  'DAD.CLIENT_WAREHOUSE_SETTINGS_MANAGE',
  'DAD.LOGICAL_WAREHOUSE_MANAGE',
  'DAD.PRODUCT_CATALOG_MANAGE',
  'DAD.BATCH_MANAGE',
];

// Espelha o registro real de app.module.ts: via NestModule.configure(), não
// `app.use()` cru — só assim o Nest garante rodar depois do body-parser e
// antes do roteamento (ver o comentário em app.module.ts para o porquê).
@Module({
  imports: [DatabaseModule, RbacModule, AuthModule, AuditModule, CadastroModule],
})
class TestAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(rejectActorSpoofingMiddleware).forRoutes('*');
  }
}

describe('Cadastro - RG-003 [INVIOLÁVEL] identidade do ator nunca vem do cliente (HTTP e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let baseUrl: string;
  let accessToken: string;
  let userId: string;
  let warehouseId: string;
  let clientId: string;

  beforeAll(async () => {
    const testModule = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();

    app = testModule.createNestApplication();
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    db = testModule.get(DatabaseService);
    const authService = testModule.get(AuthService);
    const passwordService = testModule.get(PasswordService);
    const warehouseService = testModule.get(WarehouseService);
    const clientService = testModule.get(ClientService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém e2e identidade', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente e2e identidade', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );
    clientId = client.id;

    // Papel de teste sob demanda, com o catálogo completo de permissões de
    // escrita de cadastro (nenhuma GLOBAL — evita MFA no login deste teste).
    const roleResult = await db.queryGlobal(
      `INSERT INTO wms.role (code, name, area, created_by) VALUES ($1, 'Sweep de teste (cadastro)', 'INTERNAL', $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [SWEEP_ROLE_CODE, SEED_ACTOR_ID]
    );
    const roleId = roleResult.rows[0].id;
    for (const code of SWEEP_PERMISSIONS) {
      await db.queryGlobal(
        `INSERT INTO wms.role_permission (role_id, permission_code, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [roleId, code, SEED_ACTOR_ID]
      );
    }

    const user = await createTestUser(db, passwordService);
    userId = user.id;
    await assignRole(db, { userId, roleCode: SWEEP_ROLE_CODE, warehouseId, clientId });

    const login = await authService.login(user.email, user.password, 'device-e2e-actor-identity', undefined, undefined);
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /**
   * AuditInterceptor grava via `tap()` + `.catch()` (fire-and-forget — não
   * bloqueia a resposta HTTP na escrita do audit_log, ver audit.interceptor.ts).
   * Isso é intencional (latência da resposta não depende da auditoria), mas
   * significa que uma leitura imediatamente após a resposta pode correr
   * contra a escrita assíncrona — poll curto em vez de uma única tentativa.
   */
  async function findAuditRow(entity: string, entityId: string): Promise<any | undefined> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await db.queryGlobal('SELECT * FROM wms.audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1', [
        entity,
        entityId,
      ]);
      if (result.rows[0]) return result.rows[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  it('actor_user_id forjado no body é REJEITADO (400), não ignorado — e nada é criado', async () => {
    const forgedUserId = '00000000-0000-0000-0000-000000000099'; // não é o `userId` real do token
    const { status, json } = await post('/cadastro/zones', {
      warehouse_id: warehouseId,
      code: 'FORJADO',
      name: 'Zona com ator forjado',
      zone_type: 'STORAGE',
      actor_user_id: forgedUserId,
    });

    expect(status).toBe(400);
    expect(json.message).toMatch(/RG-003/);

    const rows = await db.queryGlobal('SELECT id FROM wms.zone WHERE code = $1 AND warehouse_id = $2', ['FORJADO', warehouseId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('user_id forjado na query é REJEITADO (400)', async () => {
    const res = await fetch(`${baseUrl}/cadastro/zones?user_id=00000000-0000-0000-0000-000000000099`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ warehouse_id: warehouseId, code: 'FORJADO2', name: 'Zona 2', zone_type: 'STORAGE' }),
    });
    expect(res.status).toBe(400);
  });

  it('requisição legítima: created_by e audit_log.user_id vêm do JWT — nunca de outro lugar', async () => {
    const { status, json: zone } = await post('/cadastro/zones', {
      warehouse_id: warehouseId,
      code: 'REAL01',
      name: 'Zona identidade real',
      zone_type: 'STORAGE',
    });

    expect(status).toBe(201);
    expect(zone.created_by).toBe(userId);

    const audit = await findAuditRow('zone', zone.id);
    expect(audit).toBeDefined();
    expect(audit.user_id).toBe(userId);
    expect(audit.action).toBe('CREATE');
    expect(audit.requirement_id).toBe('DOC-02 §5.2');
  });

  it('varredura: toda rota de escrita (CREATE) dos módulos de cadastro gera audit_log com o user_id do JWT', async () => {
    // Ordem sequencial por causa de dependências reais entre entidades
    // (location precisa de zone, product-packaging/barcode/batch precisam
    // de product). warehouse/client ficam fora desta varredura porque são
    // permissões GLOBAL (exigem MFA no login — cobertos separadamente pela
    // suíte já existente de sku-uniqueness/client-isolation/etc., que prova
    // a mesma garantia — created_by nunca vem do body — no nível de service).
    const sku = randomSku();

    const routes: Array<{ path: string; entity: string; requirementId: string; body: (ctx: Record<string, any>) => unknown }> = [
      {
        path: '/cadastro/storage-equipment',
        entity: 'storage_equipment',
        requirementId: 'DOC-02 §5.2',
        body: () => ({ warehouse_id: warehouseId, code: 'SWEEP-EQ', equipment_type: 'ESTANTE' }),
      },
      {
        path: '/cadastro/docks',
        entity: 'dock',
        requirementId: 'DOC-02 §5.2',
        body: () => ({ warehouse_id: warehouseId, code: 'SWEEP-DK', dock_type: 'INBOUND', has_leveler: false }),
      },
      {
        path: '/cadastro/yard-slots',
        entity: 'yard_slot',
        requirementId: 'DOC-02 §5.2',
        body: () => ({ warehouse_id: warehouseId, code: 'SWEEP-YD', slot_type: 'WAITING' }),
      },
      {
        path: '/cadastro/zones',
        entity: 'zone',
        requirementId: 'DOC-02 §5.2',
        body: () => ({ warehouse_id: warehouseId, code: 'SWEEP-ZN', name: 'Zona varredura', zone_type: 'STORAGE' }),
      },
      {
        path: '/cadastro/client-warehouse-settings',
        entity: 'client_warehouse_settings',
        requirementId: 'DOC-02 §5.1',
        body: () => ({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FEFO' }),
      },
      {
        path: '/cadastro/logical-warehouses',
        entity: 'logical_warehouse',
        requirementId: 'DOC-02 §5.1',
        body: () => ({ tenant_id: clientId, warehouse_id: warehouseId, code: 'SWEEP-LW', name: 'Armazém lógico varredura' }),
      },
      {
        // DAD.PRODUCT_CATALOG_MANAGE é CLIENT_WAREHOUSE (migration 0016) —
        // o guard exige warehouse_id no contexto da requisição mesmo product
        // sendo DE TENANT (sem coluna warehouse_id própria); vai na query,
        // não no body (mesmo padrão já usado por rbac-resolution.spec.ts).
        path: `/cadastro/products?warehouse_id=${warehouseId}`,
        entity: 'product',
        requirementId: 'DOC-02 §5.3',
        body: () => ({ tenant_id: clientId, sku, description: 'Produto varredura', species_code: 'GERAL', base_uom: 'UN' }),
      },
    ];

    const createdIds: Record<string, string> = {};

    for (const route of routes) {
      const { status, json } = await post(route.path, route.body(createdIds));
      expect(status, `${route.path} deveria retornar 2xx`).toBeLessThan(300);
      expect(json.created_by, `${route.path}: created_by deve ser o usuário do JWT`).toBe(userId);

      const audit = await findAuditRow(route.entity, json.id);
      expect(audit, `${route.path}: deveria existir uma linha em audit_log para ${route.entity}/${json.id}`).toBeDefined();
      expect(audit.user_id, `${route.path}: audit_log.user_id deveria ser o usuário do JWT`).toBe(userId);
      expect(audit.action).toBe('CREATE');
      expect(audit.requirement_id).toBe(route.requirementId);

      createdIds[route.entity] = json.id;
    }

    // Dependentes de product (sku já criado acima).
    const productId = createdIds['product'];

    const dependentRoutes: Array<{ path: string; entity: string; requirementId: string; body: unknown }> = [
      {
        path: `/cadastro/product-packaging?warehouse_id=${warehouseId}`,
        entity: 'product_packaging',
        requirementId: 'DOC-02 §5.3',
        body: { tenant_id: clientId, product_id: productId, code: 'SWEEP-PK', description: 'Embalagem varredura', qty_in_base_uom: 6 },
      },
      {
        path: `/cadastro/product-barcodes?warehouse_id=${warehouseId}`,
        entity: 'product_barcode',
        requirementId: 'DOC-02 §5.3',
        body: { tenant_id: clientId, product_id: productId, barcode: `SWEEP-${Date.now()}`, barcode_type: 'EAN13' },
      },
      {
        path: `/cadastro/batches?warehouse_id=${warehouseId}`,
        entity: 'batch',
        requirementId: 'DOC-02 §5.4',
        body: { tenant_id: clientId, product_id: productId, batch_code: 'SWEEP-BATCH' },
      },
    ];

    for (const route of dependentRoutes) {
      const { status, json } = await post(route.path, route.body);
      expect(status, `${route.path} deveria retornar 2xx`).toBeLessThan(300);
      expect(json.created_by).toBe(userId);

      const audit = await findAuditRow(route.entity, json.id);
      expect(audit, `${route.path}: deveria existir audit_log para ${route.entity}/${json.id}`).toBeDefined();
      expect(audit.user_id).toBe(userId);
      expect(audit.action).toBe('CREATE');
      expect(audit.requirement_id).toBe(route.requirementId);
    }

    // location depende de zone — usa a zone criada na varredura acima.
    const zoneId = createdIds['zone'];
    const { status: locStatus, json: location } = await post('/cadastro/locations', {
      warehouse_id: warehouseId,
      zone_id: zoneId,
      aisle: 'S1',
      module: '001',
      level: '00',
      slot: '01',
      location_type: 'STORAGE',
      max_weight_kg: 100,
      max_volume_m3: 1,
      max_pallets: 1,
      max_height_m: 2,
    });
    expect(locStatus).toBeLessThan(300);
    expect(location.created_by).toBe(userId);
    const locationAudit = await findAuditRow('location', location.id);
    expect(locationAudit).toBeDefined();
    expect(locationAudit.user_id).toBe(userId);
  });
});
