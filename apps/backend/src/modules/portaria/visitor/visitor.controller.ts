// DOC-03 RF-POR-030/031 — cadastro de visitante (POR.CADASTRO_MOTORISTA_VISITANTE)
// e gate-in/gate-out de pessoas (POR.GATE_IN/POR.GATE_OUT, mesmas permissões
// usadas para veículos — §3 não distingue pessoa de veículo nesses códigos).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { VisitorService, UpsertVisitorInput } from './visitor.service.js';
import { PersonVisitService, RegisterPersonGateInInput } from './person-visit.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('portaria/visitors')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class VisitorController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(VisitorService) private readonly visitorService: VisitorService,
    @Inject(PersonVisitService) private readonly personVisitService: PersonVisitService
  ) {}

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Audited({ entity: 'visitor', action: 'CREATE', requirementId: 'DOC-03 RF-POR-030' })
  @Post()
  upsert(@Body() body: UpsertVisitorInput, @CurrentUser() principal: RequestPrincipal) {
    return this.visitorService.upsertByDocument(body, principal.userId);
  }

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Get()
  findByDocument(@Query('document') document: string) {
    return this.visitorService.findByDocument(document);
  }

  @RequirePermission('POR.GATE_IN')
  @Post('gate-in')
  gateIn(@Body() body: RegisterPersonGateInInput, @CurrentUser() principal: RequestPrincipal) {
    return this.personVisitService.gateIn(body, principal.userId);
  }

  @RequirePermission('POR.GATE_OUT')
  @Post(':id/gate-out')
  gateOut(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal) {
    return this.personVisitService.gateOut(id, principal.userId);
  }

  @RequirePermission('POR.GATE_IN')
  @Get('on-site')
  listOnSite(@Query('warehouse_id') warehouseId: string) {
    return this.personVisitService.listOnSite(warehouseId);
  }
}
