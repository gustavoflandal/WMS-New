// DOC-08 §7 RD-FIS-004 — cadastro de emitente (CNPJ x armazém), certificado
// A1 cifrado (RNF-FIS-063) e reserva atômica de numeração (RNF-FIS-060:
// "sequencial sem lacunas").
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { SecretCipherService } from '../../../core/security/secret-cipher.service.js';
import { parsePfx } from './xml-dsig.util.js';

/** Ator de sistema para escritas disparadas por worker (mesmo padrão de expiration.service.ts). */
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export interface RegisterFiscalIssuerInput {
  tenantId: string;
  warehouseId: string;
  cnpj: string;
  corporateName: string;
  serie: number;
  ambiente?: 'HOMOLOGACAO' | 'PRODUCAO';
  actorUserId: string;
}

export interface DecryptedCertificate {
  privateKeyPem: string;
  certificatePem: string;
}

@Injectable()
export class FiscalIssuerService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(SecretCipherService) private readonly secretCipherService: SecretCipherService
  ) {}

  /** RD-FIS-004 — FIS.AMBIENTE DEVE default para HOMOLOGACAO (pré-condição da 8B). */
  async register(input: RegisterFiscalIssuerInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const result = await this.db.query(
      ctx,
      `INSERT INTO wms.fiscal_issuer (tenant_id, warehouse_id, cnpj, corporate_name, serie, ambiente, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.tenantId, input.warehouseId, input.cnpj, input.corporateName, input.serie, input.ambiente ?? 'HOMOLOGACAO', input.actorUserId]
    );
    const issuer = result.rows[0];

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'fiscal_issuer',
      entityId: issuer.id,
      action: 'CREATE',
      requirementId: 'DOC-08 RD-FIS-004',
      after: { cnpj: issuer.cnpj, corporate_name: issuer.corporate_name, ambiente: issuer.ambiente, serie: issuer.serie },
    });

    return issuer;
  }

  /**
   * RNF-FIS-063 — cifra o PFX (AES-256-GCM) e a senha separadamente; deriva
   * `cert_expires_at` do X.509 real dentro do PFX (valida a senha ao mesmo
   * tempo — parsePfx lança se a senha estiver errada).
   */
  async uploadCertificate(issuerId: string, tenantId: string, warehouseId: string, pfxBuffer: Buffer, password: string, actorUserId: string) {
    const parsed = parsePfx(pfxBuffer, password);

    const pfxCipher = this.secretCipherService.encrypt(pfxBuffer);
    const passwordCipher = this.secretCipherService.encrypt(Buffer.from(password, 'utf8'));

    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.query(
      ctx,
      `UPDATE wms.fiscal_issuer SET
         cert_ciphertext = $2, cert_iv = $3, cert_auth_tag = $4,
         cert_password_ciphertext = $5, cert_password_iv = $6, cert_password_auth_tag = $7,
         cert_expires_at = $8, updated_at = now(), updated_by = $9
       WHERE id = $1 RETURNING id, cnpj, cert_expires_at`,
      [
        issuerId,
        pfxCipher.ciphertext,
        pfxCipher.iv,
        pfxCipher.authTag,
        passwordCipher.ciphertext,
        passwordCipher.iv,
        passwordCipher.authTag,
        parsed.notAfter,
        actorUserId,
      ]
    );
    const issuer = result.rows[0];
    if (!issuer) throw new NotFoundException(`fiscal_issuer ${issuerId} not found`);

    // Nunca logar o PFX/senha em claro — só o resultado não-sensível (RNF-FIS-060).
    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'fiscal_issuer',
      entityId: issuerId,
      action: 'UPDATE',
      requirementId: 'DOC-08 RNF-FIS-063',
      after: { cert_expires_at: issuer.cert_expires_at },
    });

    return issuer;
  }

  /** Decifra em memória, pelo tempo estritamente necessário da assinatura — nunca persistido nem logado (RNF-FIS-060). */
  async getDecryptedCertificate(tenantId: string, warehouseId: string, issuerId: string): Promise<DecryptedCertificate> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: SYSTEM_ACTOR, warehouse_id: warehouseId };
    const result = await this.db.query(
      ctx,
      `SELECT cert_ciphertext, cert_iv, cert_auth_tag, cert_password_ciphertext, cert_password_iv, cert_password_auth_tag
       FROM wms.fiscal_issuer WHERE id = $1`,
      [issuerId]
    );
    const row = result.rows[0];
    if (!row || !row.cert_ciphertext) {
      throw new BadRequestException({ error: 'FISCAL_ISSUER_NO_CERTIFICATE', detail: `RNF-FIS-063: emitente ${issuerId} não tem certificado A1 cadastrado` });
    }
    const pfxBuffer = this.secretCipherService.decrypt(row.cert_ciphertext, row.cert_iv, row.cert_auth_tag);
    const passwordBuffer = this.secretCipherService.decrypt(row.cert_password_ciphertext, row.cert_password_iv, row.cert_password_auth_tag);
    const parsed = parsePfx(pfxBuffer, passwordBuffer.toString('utf8'));
    return { privateKeyPem: parsed.privateKeyPem, certificatePem: parsed.certificatePem };
  }

  /**
   * RNF-FIS-060 — reserva atômica do próximo nNF via UPDATE...RETURNING,
   * DENTRO da mesma transação que grava o número no fiscal_document (o
   * chamador passa o client já aberto — nunca abre transação própria, para
   * que a reserva e o resto do ciclo de assinatura façam rollback juntos em
   * caso de falha).
   */
  async reserveNextNumber(client: PoolClient, issuerId: string): Promise<{ nfeNumber: number; serie: number }> {
    const result = await client.query(
      `UPDATE wms.fiscal_issuer SET next_nfe_number = next_nfe_number + 1, updated_at = now()
       WHERE id = $1 RETURNING next_nfe_number - 1 AS reserved_number, serie`,
      [issuerId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException(`fiscal_issuer ${issuerId} not found`);
    return { nfeNumber: Number(row.reserved_number), serie: Number(row.serie) };
  }
}
