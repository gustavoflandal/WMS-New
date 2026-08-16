// DOC-12 RN-SEG-012 [INVIOLÁVEL] — toda rota REST e todo handler de
// WebSocket DEVEM declarar a permissão exigida. Este é o marcador
// "positivo" (RBAC); ver public.decorator.ts e authenticated.decorator.ts
// para os dois outros marcadores aceitos pelo RouteAuditService.
import { SetMetadata } from '@nestjs/common';

export const ROUTE_DECLARATION_KEY = 'route_declaration';

export type RouteDeclaration = { kind: 'permission'; code: string } | { kind: 'public' } | { kind: 'authenticated' };

export function RequirePermission(code: string): MethodDecorator {
  return SetMetadata(ROUTE_DECLARATION_KEY, { kind: 'permission', code } satisfies RouteDeclaration);
}
