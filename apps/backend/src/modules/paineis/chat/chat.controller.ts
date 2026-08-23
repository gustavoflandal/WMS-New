// DOC-10 §4.4 — RF-PAI-030/RN-PAI-031. Convenção `paineis/<domínio-plural>`.
// Mesma nota estrutural de chat.service.ts: nenhuma rota aqui aciona
// operação alguma — só criar/entrar em sala, enviar e listar mensagem.
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

@Controller('paineis/chat')
@UseGuards(PermissionGuard)
export class ChatController {
  constructor(@Inject(ChatService) private readonly chatService: ChatService) {}

  @RequirePermission('PAI.CHAT')
  @Post('salas/armazem-turno')
  getOrCreateWarehouseShiftRoom(@Body() body: { warehouse_id: string }, @CurrentUser() principal: RequestPrincipal) {
    return this.chatService.getOrCreateWarehouseShiftRoom(body.warehouse_id, principal.userId);
  }

  @RequirePermission('PAI.CHAT')
  @Post('salas/operacao')
  getOrCreateOperationRoom(@Body() body: { operation_flow_id: string; tenant_id: string; warehouse_id: string }, @CurrentUser() principal: RequestPrincipal) {
    return this.chatService.getOrCreateOperationRoom(body.operation_flow_id, body.tenant_id, body.warehouse_id, principal.userId);
  }

  @RequirePermission('PAI.CHAT')
  @Post('salas/:id/mensagens')
  sendMessage(
    @Param('id') roomId: string,
    @Body() body: { text: string; attachment_url?: string; mentioned_user_ids?: string[] },
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.chatService.sendMessage({
      roomId,
      senderUserId: principal.userId,
      body: body.text,
      attachmentUrl: body.attachment_url,
      mentionedUserIds: body.mentioned_user_ids,
    });
  }

  @RequirePermission('PAI.CHAT')
  @Get('salas/:id/mensagens')
  listMessages(
    @Param('id') roomId: string,
    @Query('tenant_id') tenantId: string | undefined,
    @Query('warehouse_id') warehouseId: string,
    @CurrentUser() principal: RequestPrincipal
  ) {
    return this.chatService.listMessages(roomId, tenantId ?? null, warehouseId, principal.userId);
  }
}
