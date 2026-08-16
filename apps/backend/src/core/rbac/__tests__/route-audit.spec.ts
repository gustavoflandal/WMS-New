// Scenario DOC-12 §6 — "Deny por omissão no registro de rotas": uma rota
// sem declaração de permissão faz o boot da aplicação falhar. Teste
// unitário (sem DB) — exercita só RouteAuditService + DiscoveryModule,
// isolado de RbacModule (que precisa de Postgres/JWT_SECRET para os
// outros providers).
import { Test } from '@nestjs/testing';
import { Controller, Get } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { RouteAuditService } from '../route-audit.service.js';
import { RequirePermission } from '../decorators/require-permission.decorator.js';
import { Public } from '../decorators/public.decorator.js';
import { Authenticated } from '../decorators/authenticated.decorator.js';

@Controller('test-good')
class GoodController {
  @Public()
  @Get('public')
  publicRoute() {
    return 'ok';
  }

  @Authenticated()
  @Get('authenticated')
  authenticatedRoute() {
    return 'ok';
  }

  @RequirePermission('DAD.WAREHOUSE_MANAGE')
  @Get('permissioned')
  permissionedRoute() {
    return 'ok';
  }
}

@Controller('test-bad')
class UndeclaredRouteController {
  @Get() // RN-SEG-012: sem @Public()/@Authenticated()/@RequirePermission() — deve derrubar o boot.
  undeclared() {
    return 'should never boot';
  }
}

describe('RouteAuditService - DOC-12 RN-SEG-012 [INVIOLÁVEL] deny por omissão', () => {
  it('boot passa quando toda rota declara @Public/@Authenticated/@RequirePermission', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [GoodController],
      providers: [RouteAuditService],
    }).compile();
    const app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBeDefined();
    await app.close();
  });

  it('boot FALHA (aponta a rota) quando alguma rota não declara nada', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [GoodController, UndeclaredRouteController],
      providers: [RouteAuditService],
    }).compile();
    const app = moduleRef.createNestApplication();

    let caught: Error | undefined;
    try {
      await app.init();
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/RN-SEG-012/);
    expect(caught!.message).toMatch(/UndeclaredRouteController\.undeclared/);
  });
});
