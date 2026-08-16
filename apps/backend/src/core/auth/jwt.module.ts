// Módulo isolado só para JwtService — evita ciclo AuthModule <-> RbacModule
// (AuthService precisa de RbacService.computeAssignmentsHash(); PermissionGuard,
// dentro de RbacModule, precisa de JwtService). Ambos importam JwtModule,
// nenhum depende do outro diretamente.
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from './jwt.service.js';

@Module({
  imports: [ConfigModule],
  providers: [JwtService],
  exports: [JwtService],
})
export class JwtModule {}
