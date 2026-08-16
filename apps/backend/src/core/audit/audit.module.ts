// DOC-12 §4.4 — trilha de auditoria.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { AuditService } from './audit.service.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditController } from './audit.controller.js';

@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [AuditController],
  providers: [AuditService, AuditInterceptor],
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}
