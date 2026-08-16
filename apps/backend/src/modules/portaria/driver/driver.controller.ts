// DOC-03 §3 — permissão POR.CADASTRO_MOTORISTA_VISITANTE. Cadastro de
// motorista é normalmente um efeito colateral do gate-in (RF-POR-011), mas
// também é exposto como manutenção direta (edição de CNH/telefone) para o
// papel dedicado a essa permissão.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { DriverService, UpsertDriverInput } from './driver.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('portaria/drivers')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class DriverController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DriverService) private readonly driverService: DriverService) {}

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Audited({ entity: 'driver', action: 'CREATE', requirementId: 'DOC-03 RF-POR-011' })
  @Post()
  upsert(@Body() body: UpsertDriverInput, @CurrentUser() principal: RequestPrincipal) {
    return this.driverService.upsertByCpf(body, principal.userId);
  }

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Get()
  findByCpf(@Query('cpf') cpf: string) {
    return this.driverService.findByCpf(cpf);
  }

  @RequirePermission('POR.CADASTRO_MOTORISTA_VISITANTE')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.driverService.findById(id);
  }
}
