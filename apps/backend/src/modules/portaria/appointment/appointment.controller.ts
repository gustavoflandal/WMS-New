// DOC-03 §4.1 — Agendamento. POR.AGENDAMENTO_CRIAR (CLIENT_WAREHOUSE) é o
// portão de rota para create/read/cancel/reschedule — a regra fina de
// "criador OU POR.AGENDAMENTO_GERIR" (RF-POR-003) é decidida dentro do
// service (AppointmentService.assertCancelAuthorization), não na rota.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { AppointmentService, CreateAppointmentInput } from './appointment.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

interface CancelBody {
  tenant_id: string;
  warehouse_id: string;
  reason: string;
}

interface RescheduleBody {
  tenant_id: string;
  warehouse_id: string;
  new_window_config_id: string;
  new_window_date: string;
  reason: string;
}

@Controller('portaria/appointments')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class AppointmentController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(AppointmentService) private readonly appointmentService: AppointmentService) {}

  @RequirePermission('POR.AGENDAMENTO_CRIAR')
  @Audited({ entity: 'appointment', action: 'CREATE', requirementId: 'DOC-03 RF-POR-001' })
  @Post()
  create(@Body() body: CreateAppointmentInput, @CurrentUser() principal: RequestPrincipal) {
    return this.appointmentService.create(body, principal.userId);
  }

  @RequirePermission('POR.AGENDAMENTO_CRIAR')
  @Get('next-available-windows')
  findNextAvailableWindows(
    @Query('warehouse_id') warehouseId: string,
    @Query('direction') direction: 'INBOUND' | 'OUTBOUND'
  ) {
    return this.appointmentService.findNextAvailableWindows(warehouseId, direction);
  }

  @RequirePermission('POR.AGENDAMENTO_CRIAR')
  @Get(':id')
  findById(@Param('id') id: string, @Query('tenant_id') tenantId: string, @CurrentUser() principal: RequestPrincipal) {
    return this.appointmentService.findById(id, tenantId, principal.userId);
  }

  @RequirePermission('POR.AGENDAMENTO_CRIAR')
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: CancelBody, @CurrentUser() principal: RequestPrincipal) {
    return this.appointmentService.cancel(id, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }

  @RequirePermission('POR.AGENDAMENTO_CRIAR')
  @Post(':id/reschedule')
  reschedule(@Param('id') id: string, @Body() body: RescheduleBody, @CurrentUser() principal: RequestPrincipal) {
    return this.appointmentService.reschedule(
      id,
      body.tenant_id,
      body.warehouse_id,
      body.new_window_config_id,
      body.new_window_date,
      body.reason,
      principal.userId
    );
  }
}
