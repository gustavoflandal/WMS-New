import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { OperationFlowService } from './operation-flow.service.js';
import { OperationFlowController } from './operation-flow.controller.js';

@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [OperationFlowController],
  providers: [OperationFlowService],
  exports: [OperationFlowService],
})
export class OperationFlowModule {}
