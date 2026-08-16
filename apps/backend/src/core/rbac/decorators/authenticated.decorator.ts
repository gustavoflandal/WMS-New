// DOC-12 — marcador para rotas de autosserviço que exigem apenas um JWT
// válido (identidade autenticada), sem checagem de permissão RBAC
// específica (ex.: trocar a própria senha, habilitar o próprio MFA).
// Conta como "declaração" para o RouteAuditService (RN-SEG-012).
import { SetMetadata } from '@nestjs/common';
import { ROUTE_DECLARATION_KEY, RouteDeclaration } from './require-permission.decorator.js';

export function Authenticated(): MethodDecorator {
  return SetMetadata(ROUTE_DECLARATION_KEY, { kind: 'authenticated' } satisfies RouteDeclaration);
}
