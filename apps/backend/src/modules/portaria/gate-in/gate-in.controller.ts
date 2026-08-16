// DOC-03 §4.2 — Gate-in de veículos. Auditoria de CREATE/STATUS_CHANGE feita
// explicitamente dentro do GateInService (before/after reais) — nenhuma
// rota aqui usa @Audited()/AuditInterceptor para evitar registro duplicado.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { GateInService, RegisterGateInInput } from './gate-in.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface ResumeBody {
  tenant_id: string;
  warehouse_id: string;
}

interface ManualOverrideBody {
  tenant_id: string;
  warehouse_id: string;
  reason: string;
}

@Controller('portaria/gate-in')
@UseGuards(PermissionGuard)
export class GateInController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(GateInService) private readonly gateInService: GateInService) {}

  @RequirePermission('POR.GATE_IN')
  @Post()
  registerGateIn(@Body() body: RegisterGateInInput, @CurrentUser() principal: RequestPrincipal) {
    return this.gateInService.registerGateIn(body, principal.userId);
  }

  @RequirePermission('POR.GATE_IN')
  @Post(':visitId/resume-after-exception')
  resumeAfterExceptionDecision(@Param('visitId') visitId: string, @Body() body: ResumeBody, @CurrentUser() principal: RequestPrincipal) {
    return this.gateInService.resumeAfterExceptionDecision(visitId, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('POR.GATE_IN')
  @Post(':visitId/retry-slot')
  retrySlotAllocation(@Param('visitId') visitId: string, @Body() body: ResumeBody, @CurrentUser() principal: RequestPrincipal) {
    return this.gateInService.retrySlotAllocation(visitId, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('POR.ACIONAR_CANCELA')
  @Post(':visitId/manual-cancela-override')
  confirmManualCancelaOverride(@Param('visitId') visitId: string, @Body() body: ManualOverrideBody, @CurrentUser() principal: RequestPrincipal) {
    return this.gateInService.confirmManualCancelaOverride(visitId, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }
}
