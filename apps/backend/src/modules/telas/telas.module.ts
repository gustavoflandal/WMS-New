// RNF-ARQ-001: Telas module — DOC-17 (Sessão 10A: Parte A, Detalhe de Etapa).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { OperationFlowModule } from '../../core/operation-flow/operation-flow.module.js';

import { StepDetailController } from './step-detail/step-detail.controller.js';
import { StepDetailService } from './step-detail/step-detail.service.js';

@Module({
  imports: [DatabaseModule, RbacModule, OperationFlowModule],
  controllers: [StepDetailController],
  providers: [StepDetailService],
  exports: [StepDetailService],
})
export class TelasModule {}
