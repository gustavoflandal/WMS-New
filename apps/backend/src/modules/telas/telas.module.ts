// RNF-ARQ-001: Telas module — DOC-17. Sessão 10A: Parte A (Detalhe de
// Etapa). Sessão 10B: Parte B fatia 1 (Formulário de Campo) — importa
// RecebimentoModule só pelo PutawayTaskService/PutawayEngineService que já
// exporta (reuso do motor real, RN-TEL-011 nunca duplica validação de
// domínio) — ver docs/PROMPT-SESSAO-10B-doc17-formulario-campo.md.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module.js';
import { RbacModule } from '../../core/rbac/rbac.module.js';
import { AuditModule } from '../../core/audit/audit.module.js';
import { StorageModule } from '../../core/storage/storage.module.js';
import { WorkflowModule } from '../../core/workflow/workflow.module.js';
import { OperationFlowModule } from '../../core/operation-flow/operation-flow.module.js';
import { RecebimentoModule } from '../recebimento/recebimento.module.js';

// Reinstanciado aqui (não exportado por CadastroModule) — stateless, mesmo
// padrão já usado em recebimento.module.ts/portaria.module.ts.
import { DocumentNumberingService } from '../cadastro/document-numbering/document-numbering.service.js';

import { StepDetailController } from './step-detail/step-detail.controller.js';
import { StepDetailService } from './step-detail/step-detail.service.js';
import { FieldFormController } from './field-form/field-form.controller.js';
import { FieldFormService } from './field-form/field-form.service.js';
import { FieldFormPdfService } from './field-form/field-form-pdf.service.js';
import { TranscriptionController } from './transcription/transcription.controller.js';
import { TranscriptionService } from './transcription/transcription.service.js';

@Module({
  // WorkflowModule: DOC-17 §8 abre exceções TEL.FORMULARIO_EXPIRADO /
  // TEL.SEGREGACAO_TRANSCRICAO (RN-TEL-032/033).
  imports: [DatabaseModule, RbacModule, AuditModule, StorageModule, WorkflowModule, OperationFlowModule, RecebimentoModule],
  controllers: [StepDetailController, FieldFormController, TranscriptionController],
  providers: [StepDetailService, FieldFormService, FieldFormPdfService, TranscriptionService, DocumentNumberingService],
  exports: [StepDetailService, FieldFormService, TranscriptionService],
})
export class TelasModule {}
