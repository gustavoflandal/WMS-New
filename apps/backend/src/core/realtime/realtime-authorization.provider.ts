// DOC-12 — substitui o provider de desenvolvimento (`useValue: null`) do
// RealtimeGateway. RN-SEG-012: WS handlers também precisam de checagem de
// permissão real, não só a declaração.
import { Injectable } from '@nestjs/common';
import { RbacService } from '../rbac/rbac.service.js';

@Injectable()
export class RealtimeAuthorizationProvider {
  constructor(private readonly rbacService: RbacService) {}

  async canSubscribe(userId: string | undefined, _topic: string, warehouseId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    return this.rbacService.hasPermission(userId, 'SEG.REALTIME_SUBSCRIBE', { warehouseId });
  }
}
