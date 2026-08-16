// DOC-03 §3 — Gestor de Armazém configura janelas/prioridades/tolerâncias;
// POR.AGENDAMENTO_GERIR é a permissão usada aqui (não há permissão dedicada
// a "configuração de janela" em §3 — RN-POR-002 trata capacidade de janela
// como parte da gestão de agendamento).
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AppointmentWindowConfigService, CreateAppointmentWindowConfigInput } from './appointment-window-config.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('portaria/appointment-window-configs')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class AppointmentWindowConfigController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(AppointmentWindowConfigService) private readonly service: AppointmentWindowConfigService) {}

  @RequirePermission('POR.AGENDAMENTO_GERIR')
  @Audited({ entity: 'appointment_window_config', action: 'CREATE', requirementId: 'DOC-03 RD-POR-007' })
  @Post()
  create(@Body() body: CreateAppointmentWindowConfigInput, @CurrentUser() principal: RequestPrincipal) {
    return this.service.create(body, principal.userId);
  }

  @RequirePermission('POR.AGENDAMENTO_GERIR')
  @Get()
  listByWarehouse(@Query('warehouse_id') warehouseId: string) {
    return this.service.listByWarehouse(warehouseId);
  }

  @RequirePermission('POR.AGENDAMENTO_GERIR')
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }
}
