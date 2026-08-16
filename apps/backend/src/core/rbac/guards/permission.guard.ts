// DOC-12 §4.2 [INVIOLÁVEL] — guard único que cobre autenticação (JWT) +
// RN-SEG-011 (resolução multi-dimensional) + RN-SEG-012 (deny por
// omissão, defesa em profundidade em runtime — o boot já teria falhado
// via RouteAuditService se a rota não declarasse nada) + RF-SEG-003
// (invalidação por assignments_hash) + RF-SEG-006 (separação de área).
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '../../auth/jwt.service.js';
import { RbacService } from '../rbac.service.js';
import { ROUTE_DECLARATION_KEY, RouteDeclaration } from '../decorators/require-permission.decorator.js';

export interface RequestPrincipal {
  userId: string;
  area: 'INTERNAL' | 'CLIENT_PORTAL';
  assignmentsHash: string;
}

@Injectable()
export class PermissionGuard implements CanActivate {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(RbacService) private readonly rbacService: RbacService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declaration = this.reflector.get<RouteDeclaration | undefined>(ROUTE_DECLARATION_KEY, context.getHandler());

    if (!declaration) {
      // RN-SEG-012: defesa em profundidade — RouteAuditService já deveria
      // ter impedido o boot; se chegou aqui em runtime, nega mesmo assim.
      throw new ForbiddenException('RN-SEG-012: route missing permission declaration');
    }

    if (declaration.kind === 'public') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const token = authHeader.substring('Bearer '.length);

    let claims;
    try {
      claims = this.jwtService.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }

    // RF-SEG-003: mudança de atribuição invalida tokens ativos.
    const currentHash = await this.rbacService.computeAssignmentsHash(claims.sub);
    if (currentHash !== claims.assignments_hash) {
      throw new UnauthorizedException('assignments changed — please reauthenticate');
    }

    const principal: RequestPrincipal = { userId: claims.sub, area: claims.area, assignmentsHash: claims.assignments_hash };
    request.principal = principal;

    if (declaration.kind === 'authenticated') {
      return true;
    }

    // declaration.kind === 'permission' — rotas desta sessão são todas de
    // área INTERNAL (RF-SEG-006: nenhuma tela interna é acessível com
    // token de portal e vice-versa).
    if (principal.area !== 'INTERNAL') {
      throw new ForbiddenException('RF-SEG-006: portal token cannot access internal routes');
    }

    const warehouseId = request.params?.warehouse_id ?? request.query?.warehouse_id ?? request.body?.warehouse_id;
    const clientId = request.params?.tenant_id ?? request.query?.tenant_id ?? request.body?.tenant_id;

    const allowed = await this.rbacService.hasPermission(claims.sub, declaration.code, { warehouseId, clientId });
    if (!allowed) {
      throw new ForbiddenException(`missing permission ${declaration.code}`);
    }

    return true;
  }
}
