// DOC-10 — módulo Painéis, Dashboards e Tempo Real.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { OperationsBoardService } from './operacoes/operations-board.service.js';
import { OperationsBoardController } from './operacoes/operations-board.controller.js';
import { BoardPreferenceService } from './operacoes/board-preference.service.js';

@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [OperationsBoardController],
  providers: [OperationsBoardService, BoardPreferenceService],
  exports: [OperationsBoardService],
})
export class PaineisModule {}
