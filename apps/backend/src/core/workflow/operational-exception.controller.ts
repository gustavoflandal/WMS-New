// DOC-12 §4.5 — endpoints do motor de Workflow de Aprovação. Criar uma
// exceção não exige uma permissão RBAC específica (DOC-12 não declara
// nenhuma para isso — é o efeito colateral de QUALQUER operação bloqueada
// que pode ser solicitada por qualquer usuário autenticado); decidir
// (aprovar/rejeitar) exige SEG.APROVACAO_EXCECAO (RD-SEG-014).
import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { OperationalExceptionService, CreateExceptionInput } from './operational-exception.service.js';
import { PermissionGuard } from '../rbac/guards/permission.guard.js';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator.js';
import { Authenticated } from '../rbac/decorators/authenticated.decorator.js';
import { CurrentUser } from '../rbac/decorators/current-user.decorator.js';
import { RequestPrincipal } from '../rbac/guards/permission.guard.js';

interface DecideBody {
  tenant_id: string;
  warehouse_id: string;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}

@Controller('workflow/exceptions')
@UseGuards(PermissionGuard)
export class OperationalExceptionController {
  constructor(private readonly service: OperationalExceptionService) {}

  @Authenticated()
  @Post()
  create(@CurrentUser() principal: RequestPrincipal, @Body() body: Omit<CreateExceptionInput, 'requestedBy'>) {
    return this.service.create({ ...body, requestedBy: principal.userId });
  }

  @RequirePermission('SEG.APROVACAO_EXCECAO')
  @Post(':id/decide')
  decide(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal, @Body() body: DecideBody) {
    return this.service.decide(id, body.tenant_id, body.warehouse_id, principal.userId, body.decision, body.reason);
  }
}
