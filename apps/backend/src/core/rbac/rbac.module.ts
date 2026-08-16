// DOC-12 §4.2 — RBAC multi-dimensional. RouteAuditService (RN-SEG-012)
// roda em onModuleInit() e derruba o boot se alguma rota/handler não
// declarar permissão.
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module.js';
import { JwtModule } from '../auth/jwt.module.js';
import { RbacService } from './rbac.service.js';
import { RouteAuditService } from './route-audit.service.js';
import { PermissionGuard } from './guards/permission.guard.js';

@Module({
  imports: [DiscoveryModule, DatabaseModule, JwtModule],
  providers: [RbacService, RouteAuditService, PermissionGuard],
  // JwtModule re-exportado: qualquer módulo que importe RbacModule para usar
  // PermissionGuard em @UseGuards() precisa também de JwtService no próprio
  // escopo — Nest resolve as dependências do guard usando o módulo hospedeiro
  // do controller, não o módulo onde o guard foi originalmente declarado.
  exports: [JwtModule, RbacService, PermissionGuard],
})
export class RbacModule {}
