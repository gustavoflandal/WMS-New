// Scenario DOC-12 §6 — "Invalidação de tokens após mudança de atribuição"
// (RF-SEG-003): João autenticado com access token válido; o Administrador
// de Segurança remove uma atribuição; a PRÓXIMA requisição de João deve
// ser rejeitada com 401 (assignments_hash não bate mais).
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper.js';
import { AuthService } from '../../auth/auth.service.js';
import { PasswordService } from '../../auth/password.service.js';
import { JwtService } from '../../auth/jwt.service.js';
import { RbacService } from '../rbac.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PermissionGuard } from '../guards/permission.guard.js';
import { RequirePermission } from '../decorators/require-permission.decorator.js';
import { createTestUser, assignRole, SEED_ACTOR_ID } from '../../__tests__/security-test-helpers.js';
import { WarehouseService } from '../../../modules/cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../modules/cadastro/client/client.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode } from '../../../modules/cadastro/__tests__/test-helpers.js';

// Mesmo padrão já usado em test-setup.helper.ts (fallback de env var para
// teste): garante JWT_SECRET presente independentemente de como o
// ConfigModule resolveu (ou não) o .env neste processo de teste.
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-token-invalidation-spec';

// Permissão CLIENT_WAREHOUSE (não GLOBAL) de propósito: RF-SEG-005 exige
// MFA para quem possui QUALQUER permissão GLOBAL, e este teste foca em
// RF-SEG-003 (invalidação por assignments_hash), não em MFA.
class DummyController {
  @RequirePermission('DAD.PRODUCT_CATALOG_MANAGE')
  protectedRoute() {
    return 'ok';
  }
}

function fakeContext(
  bearerToken: string | undefined,
  handler: (...args: any[]) => any,
  query: { warehouse_id?: string; tenant_id?: string } = {}
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {},
        params: {},
        query,
        body: {},
      }),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => DummyController,
  } as unknown as ExecutionContext;
}

describe('PermissionGuard - DOC-12 RF-SEG-003 invalidação por mudança de atribuição', () => {
  let testContext: TestContext;
  let authService: AuthService;
  let permissionGuard: PermissionGuard;
  let passwordService: PasswordService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    passwordService = new PasswordService(testContext.databaseService);
    const jwtService = new JwtService();
    const rbacService = new RbacService(testContext.databaseService);
    const auditService = new AuditService(testContext.databaseService);
    authService = new AuthService(testContext.databaseService, passwordService, jwtService, rbacService, auditService);
    permissionGuard = new PermissionGuard(new Reflector(), jwtService, rbacService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('token válido é aceito; após remover a atribuição do usuário, o MESMO token passa a ser rejeitado com 401', async () => {
    const cadastroAuditService = new AuditService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, cadastroAuditService);
    const clientService = new ClientService(testContext.databaseService, cadastroAuditService);
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém invalidação de token', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente invalidação de token', cnpj: generateValidCnpj() },
      SEED_ACTOR_ID
    );

    const joao = await createTestUser(testContext.databaseService, passwordService);
    await assignRole(testContext.databaseService, { userId: joao.id, roleCode: 'CONFERENTE', warehouseId: warehouse.id, clientId: client.id });

    const login = await authService.login(joao.email, joao.password, 'device-1', undefined, undefined);

    const query = { warehouse_id: warehouse.id, tenant_id: client.id };

    // Token recém-emitido: aceito.
    const ctx1 = fakeContext(login.accessToken, DummyController.prototype.protectedRoute, query);
    await expect(permissionGuard.canActivate(ctx1)).resolves.toBe(true);

    // Administrador de Segurança remove a atribuição de João. Nota: DELETE
    // físico NÃO é permitido em user_role_assignment (wms_app só tem
    // SELECT/INSERT/UPDATE por padrão desde a correção da migration 0010 —
    // e a tabela nem tem coluna `status`, só `valid_from`/`valid_until`).
    // "Remover" uma atribuição é expirá-la, não apagar a linha.
    await testContext.databaseService.queryGlobal(`UPDATE wms.user_role_assignment SET valid_until = CURRENT_DATE - 1 WHERE user_id = $1`, [
      joao.id,
    ]);

    // MESMO access token, mesma requisição — agora rejeitado (assignments_hash não bate mais).
    const ctx2 = fakeContext(login.accessToken, DummyController.prototype.protectedRoute, query);
    await expect(permissionGuard.canActivate(ctx2)).rejects.toBeInstanceOf(UnauthorizedException);

    // João reautentica: recebe um token novo, com o assignments_hash atualizado.
    // (Sem atribuições, CONFERENTE foi removido — login ainda funciona, mas
    // o novo token não teria a permissão antiga.)
    const reLogin = await authService.login(joao.email, joao.password, 'device-1', undefined, undefined);
    expect(reLogin.accessToken).not.toBe(login.accessToken);
  });
});
