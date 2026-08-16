// DOC-12 RN-SEG-051 — "CPF/CNH DEVEM ser exibidos mascarados exceto para
// papéis com permissão POR.DADO_PESSOAL_COMPLETO; toda exibição completa
// gera auditoria (RN-SEG-032)". Reutilizável por qualquer módulo futuro
// que trate dados pessoais (DOC-03: motorista, visitante).
import { Injectable } from '@nestjs/common';
import { RbacService } from '../rbac/rbac.service.js';
import { AuditService } from '../audit/audit.service.js';
import { maskCpf, maskCnh } from './masking.util.js';

export interface RevealPersonalDataParams {
  userId: string;
  value: string;
  kind: 'CPF' | 'CNH';
  entity: string;
  entityId: string;
  warehouseId: string;
  tenantId?: string | null;
  deviceId?: string;
}

@Injectable()
export class PersonalDataAccessService {
  constructor(
    private readonly rbacService: RbacService,
    private readonly auditService: AuditService
  ) {}

  /**
   * Retorna o valor mascarado por padrão; se o usuário possuir
   * POR.DADO_PESSOAL_COMPLETO no armazém informado, retorna o valor
   * completo E grava auditoria (RN-SEG-032: "toda leitura de dado pessoal
   * sensível"). action='EXPORT' reaproveita o enum existente de audit_log
   * — DOC-12 §6 aceita "EXPORT ou leitura sensível" como o registro válido.
   */
  async reveal(params: RevealPersonalDataParams): Promise<{ value: string; wasMasked: boolean }> {
    const canViewFull = await this.rbacService.hasPermission(params.userId, 'POR.DADO_PESSOAL_COMPLETO', {
      warehouseId: params.warehouseId,
    });

    if (!canViewFull) {
      const masked = params.kind === 'CPF' ? maskCpf(params.value) : maskCnh(params.value);
      return { value: masked, wasMasked: true };
    }

    await this.auditService.record({
      tenantId: params.tenantId ?? null,
      warehouseId: params.warehouseId,
      userId: params.userId,
      origin: 'WEB',
      deviceId: params.deviceId ?? null,
      entity: params.entity,
      entityId: params.entityId,
      action: 'EXPORT',
      reason: `RN-SEG-051: exibição completa de ${params.kind}`,
    });

    return { value: params.value, wasMasked: false };
  }
}
