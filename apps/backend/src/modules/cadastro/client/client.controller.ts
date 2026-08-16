// DOC-02 §5.1 — client. [LACUNA: RBAC DOC-12] sem autenticação real.
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ClientService, CreateClientInput, UpdateClientInput } from './client.service.js';
import { NoAuthGuard } from '../shared/no-auth.guard.js';

@Controller('cadastro/clients')
@UseGuards(NoAuthGuard)
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Post()
  create(@Body() body: CreateClientInput) {
    return this.clientService.create(body);
  }

  @Get(':id')
  findById(@Param('id') id: string, @Query('actor_user_id') actorUserId: string) {
    return this.clientService.findById(id, actorUserId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateClientInput) {
    return this.clientService.update(id, body);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @Body('actor_user_id') actorUserId: string) {
    return this.clientService.deactivate(id, actorUserId);
  }
}
