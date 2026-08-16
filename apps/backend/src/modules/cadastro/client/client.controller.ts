// DOC-02 §5.1 — client. Permissão DAD.CLIENT_MANAGE (GLOBAL, DOC-12
// migration 0016) — substitui o [LACUNA: RBAC DOC-12] da Sessão 2A.
// DOC-12 RG-003 [INVIOLÁVEL]: actor_user_id vem exclusivamente de
// @CurrentUser() — nunca de body/query.
import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ClientService, CreateClientInput, UpdateClientInput } from './client.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import { AuditInterceptor } from '../../../core/audit/audit.interceptor.js';
import { Audited } from '../../../core/audit/decorators/audited.decorator.js';

@Controller('cadastro/clients')
@UseGuards(PermissionGuard)
@UseInterceptors(AuditInterceptor)
export class ClientController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(ClientService) private readonly clientService: ClientService) {}

  @RequirePermission('DAD.CLIENT_MANAGE')
  @Audited({ entity: 'client', action: 'CREATE', requirementId: 'DOC-02 §5.1' })
  @Post()
  create(@Body() body: CreateClientInput, @CurrentUser() principal: RequestPrincipal) {
    return this.clientService.create(body, principal.userId);
  }

  @RequirePermission('DAD.CLIENT_MANAGE')
  @Get(':id')
  findById(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal) {
    return this.clientService.findById(id, principal.userId);
  }

  @RequirePermission('DAD.CLIENT_MANAGE')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateClientInput, @CurrentUser() principal: RequestPrincipal) {
    return this.clientService.update(id, body, principal.userId);
  }

  @RequirePermission('DAD.CLIENT_MANAGE')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentUser() principal: RequestPrincipal) {
    return this.clientService.deactivate(id, principal.userId);
  }
}
