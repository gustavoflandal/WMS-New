// DOC-12 §4.6 — LGPD. RD-SEG-050 (inventário) é documental (ver comentário
// em masking.util.ts / relatório da sessão). RF-SEG-052 (relatório/
// retificação/anonimização por titular) fica como débito nesta sessão:
// os dados pessoais reais (motorista, visitante — DOC-03) ainda não têm
// tabela própria para operar sobre. Ver docs/relatorios/SESSAO-3-relatorio.md.
import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { PersonalDataAccessService } from './personal-data-access.service.js';

@Module({
  imports: [RbacModule, AuditModule],
  providers: [PersonalDataAccessService],
  exports: [PersonalDataAccessService],
})
export class LgpdModule {}
