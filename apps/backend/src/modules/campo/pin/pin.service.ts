// DOC-12 RF-SEG-004 / DOC-15 RF-COL-030 — PIN pessoal de 6 dígitos para
// re-bloqueio por inatividade (5 min) na área de campo do PWA. Mesmo padrão
// já usado para senha (password_hash/failed_login_count/locked_until,
// migration 0015) — reaproveita PasswordService (Argon2), não duplica hash.
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';

const MAX_PIN_FAILURES = 3;
const PIN_PATTERN = /^[0-9]{6}$/;

@Injectable()
export class PinService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(PasswordService) private readonly passwordService: PasswordService
  ) {}

  /** RF-COL-030: define/troca o PIN pessoal — qualquer usuário autenticado, sobre si mesmo. */
  async setPin(userId: string, pin: string): Promise<void> {
    if (!PIN_PATTERN.test(pin)) {
      throw new BadRequestException({ error: 'INVALID_PIN_FORMAT', detail: 'RF-SEG-004: PIN deve ter exatamente 6 dígitos' });
    }
    const hash = await this.passwordService.hash(pin);
    await this.db.queryGlobal(`UPDATE wms.user SET pin_hash = $2, pin_failed_count = 0, pin_locked_until = NULL WHERE id = $1`, [userId, hash]);
  }

  /**
   * RF-COL-030/RF-SEG-004 [determinístico]: verifica o PIN de reautenticação
   * após bloqueio por inatividade. 3 falhas consecutivas exigem login
   * completo (o chamador — controller/frontend — decide o que fazer com
   * `requiresFullLogin: true`, esta função não invalida o JWT).
   */
  async verifyPin(userId: string, pin: string, warehouseId: string): Promise<{ ok: boolean; requiresFullLogin: boolean }> {
    const result = await this.db.queryGlobal(`SELECT pin_hash, pin_failed_count, pin_locked_until FROM wms.user WHERE id = $1`, [userId]);
    const user = result.rows[0];
    if (!user) throw new NotFoundException(`user ${userId} not found`);
    if (!user.pin_hash) {
      throw new BadRequestException({ error: 'PIN_NOT_SET', detail: 'RF-SEG-004: nenhum PIN definido — configure um PIN antes de usar o bloqueio por inatividade' });
    }
    if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
      throw new ForbiddenException({ error: 'PIN_LOCKED', detail: 'RF-SEG-004: PIN bloqueado após 3 falhas — faça login completo' });
    }

    const valid = await this.passwordService.verify(user.pin_hash, pin);
    if (valid) {
      await this.db.queryGlobal(`UPDATE wms.user SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = $1`, [userId]);
      return { ok: true, requiresFullLogin: false };
    }

    const failedCount = user.pin_failed_count + 1;
    const requiresFullLogin = failedCount >= MAX_PIN_FAILURES;
    await this.db.queryGlobal(
      `UPDATE wms.user SET pin_failed_count = $2, pin_locked_until = CASE WHEN $3::boolean THEN now() + INTERVAL '15 minutes' ELSE pin_locked_until END WHERE id = $1`,
      [userId, failedCount, requiresFullLogin]
    );

    await this.auditService.record({
      warehouseId,
      userId,
      origin: 'PWA',
      entity: 'user',
      entityId: userId,
      action: 'LOGIN',
      requirementId: 'DOC-12 RF-SEG-004',
      reason: `Falha de PIN (${failedCount}/${MAX_PIN_FAILURES})`,
    });

    if (requiresFullLogin) {
      throw new UnauthorizedException({ error: 'PIN_LOCKED_AFTER_FAILURES', detail: 'RF-SEG-004: 3 falhas de PIN — faça login completo' });
    }
    return { ok: false, requiresFullLogin: false };
  }
}
