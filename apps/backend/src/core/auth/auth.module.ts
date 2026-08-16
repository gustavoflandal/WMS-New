// DOC-12 §4.1 — módulo de autenticação.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { JwtModule } from './jwt.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PasswordService } from './password.service.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';

@Module({
  imports: [DatabaseModule, JwtModule, RbacModule, AuditModule],
  controllers: [AuthController],
  providers: [PasswordService, AuthService],
  exports: [PasswordService, AuthService],
})
export class AuthModule {}
