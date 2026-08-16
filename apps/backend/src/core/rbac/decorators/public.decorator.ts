// DOC-12 RN-SEG-012 — marcador explícito para rotas que não exigem
// autenticação (ex.: login, health check). Conta como "declaração" para o
// RouteAuditService (deny por omissão é sobre AUSÊNCIA de declaração, não
// proíbe rota pública desde que explicitamente marcada).
import { SetMetadata } from '@nestjs/common';
import { ROUTE_DECLARATION_KEY, RouteDeclaration } from './require-permission.decorator.js';

export function Public(): MethodDecorator {
  return SetMetadata(ROUTE_DECLARATION_KEY, { kind: 'public' } satisfies RouteDeclaration);
}
