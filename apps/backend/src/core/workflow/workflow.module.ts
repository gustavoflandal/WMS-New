// DOC-12 §4.3/§4.5 — Alçadas + Motor de Workflow de Aprovação.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { EventsModule } from '../events/events.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { ApprovalAuthorityService } from './approval-authority.service.js';
import { OperationalExceptionService } from './operational-exception.service.js';
import { OperationalExceptionController } from './operational-exception.controller.js';

@Module({
  imports: [DatabaseModule, EventsModule, AuditModule, RbacModule],
  controllers: [OperationalExceptionController],
  providers: [ApprovalAuthorityService, OperationalExceptionService],
  exports: [ApprovalAuthorityService, OperationalExceptionService],
})
export class WorkflowModule {}
