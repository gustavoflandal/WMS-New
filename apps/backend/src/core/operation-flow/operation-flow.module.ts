import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OperationFlowService } from './operation-flow.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [OperationFlowService],
  exports: [OperationFlowService],
})
export class OperationFlowModule {}
