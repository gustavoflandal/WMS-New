// DOC-12 RN-SEG-032 — marca um handler para geração automática de
// auditoria via AuditInterceptor. Reutilizável pelos módulos futuros:
// basta @UseInterceptors(AuditInterceptor) no controller + @Audited(...)
// no método.
import { SetMetadata } from '@nestjs/common';
import { AuditAction, AuditOrigin } from '../audit.service.js';

export const AUDITED_KEY = 'audited_meta';

export interface AuditedOptions {
  entity: string;
  action: AuditAction;
  origin?: AuditOrigin;
  requirementId?: string;
}

export function Audited(options: AuditedOptions): MethodDecorator {
  return SetMetadata(AUDITED_KEY, options);
}
