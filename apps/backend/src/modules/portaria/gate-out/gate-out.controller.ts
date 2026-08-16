// DOC-03 §4.5 — Gate-out. Auditoria feita explicitamente dentro do
// GateOutService (before/after reais) — sem @Audited() aqui.
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { GateOutService, RequestGateOutInput } from './gate-out.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface ForceGateOutBody {
  tenant_id: string;
  warehouse_id: string;
  reason: string;
}

interface CompleteForcedBody {
  tenant_id: string;
  warehouse_id: string;
}

@Controller('portaria/gate-out')
@UseGuards(PermissionGuard)
export class GateOutController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(GateOutService) private readonly gateOutService: GateOutService) {}

  @RequirePermission('POR.GATE_OUT')
  @Post(':visitId')
  requestGateOut(@Param('visitId') visitId: string, @Body() body: RequestGateOutInput, @CurrentUser() principal: RequestPrincipal) {
    return this.gateOutService.requestGateOut(visitId, body, principal.userId);
  }

  @RequirePermission('POR.GATE_OUT')
  @Post(':visitId/force')
  requestForcedGateOut(@Param('visitId') visitId: string, @Body() body: ForceGateOutBody, @CurrentUser() principal: RequestPrincipal) {
    return this.gateOutService.requestForcedGateOut(visitId, body.tenant_id, body.warehouse_id, body.reason, principal.userId);
  }

  @RequirePermission('POR.GATE_OUT')
  @Post(':visitId/complete-forced')
  completeForcedGateOutAfterApproval(@Param('visitId') visitId: string, @Body() body: CompleteForcedBody, @CurrentUser() principal: RequestPrincipal) {
    return this.gateOutService.completeForcedGateOutAfterApproval(visitId, body.tenant_id, body.warehouse_id, principal.userId);
  }
}
