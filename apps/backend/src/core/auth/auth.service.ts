// DOC-12 §4.1 — autenticação real: login (interno/portal), refresh
// rotativo, logout, troca de senha, MFA. Substitui qualquer provider de
// desenvolvimento.
import { Inject, Injectable, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { PasswordService } from './password.service.js';
import { JwtService, Area } from './jwt.service.js';
import { RbacService } from '../rbac/rbac.service.js';
import { AuditService } from '../audit/audit.service.js';
import { generateBase32Secret, verifyTotp } from './mfa.util.js';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  mustChangePassword: boolean;
  expiresInSeconds: number;
}

@Injectable()
export class AuthService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** RF-SEG-002/003/005/006: login interno (area=INTERNAL). */
  async login(email: string, password: string, deviceId: string, totpCode: string | undefined, ip: string | undefined): Promise<LoginResult> {
    return this.authenticate(email, password, deviceId, totpCode, ip, 'INTERNAL');
  }

  /** RF-SEG-006: login do portal (area=CLIENT_PORTAL, tenant fixo no próprio cliente). */
  async loginPortal(email: string, password: string, deviceId: string, ip: string | undefined): Promise<LoginResult> {
    return this.authenticate(email, password, deviceId, undefined, ip, 'CLIENT_PORTAL');
  }

  private async authenticate(
    email: string,
    password: string,
    deviceId: string,
    totpCode: string | undefined,
    ip: string | undefined,
    expectedArea: Area
  ): Promise<LoginResult> {
    const userResult = await this.db.queryGlobal(
      `SELECT id, email, area, password_hash, must_change_password, failed_login_count, locked_until, mfa_enabled, mfa_secret, status
       FROM wms.user WHERE email = $1`,
      [email]
    );
    const user = userResult.rows[0];

    if (!user || user.area !== expectedArea || user.status !== 'ACTIVE') {
      await this.logAttempt(email, null, false, 'USER_NOT_FOUND_OR_WRONG_AREA', ip, deviceId);
      throw new UnauthorizedException('invalid credentials');
    }

    const policy = await this.passwordService.getPolicy();

    const origin = expectedArea === 'CLIENT_PORTAL' ? 'PORTAL' : 'API';

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await this.logAttempt(email, user.id, false, 'LOCKED', ip, deviceId);
      await this.auditLogin(user.id, deviceId, origin, false, 'ACCOUNT_LOCKED');
      throw new ForbiddenException({ error: 'ACCOUNT_LOCKED', detail: `RF-SEG-002: conta bloqueada até ${user.locked_until}` });
    }

    const passwordOk = await this.passwordService.verify(user.password_hash, password);
    if (!passwordOk) {
      await this.registerFailedLogin(user.id, user.failed_login_count, policy);
      await this.logAttempt(email, user.id, false, 'BAD_PASSWORD', ip, deviceId);
      await this.auditLogin(user.id, deviceId, origin, false, 'BAD_PASSWORD');
      throw new UnauthorizedException('invalid credentials');
    }

    // RF-SEG-005: MFA TOTP obrigatório para quem possui permissão GLOBAL.
    if (expectedArea === 'INTERNAL') {
      const requiresMfa = await this.rbacService.hasAnyGlobalPermission(user.id);
      if (requiresMfa) {
        if (!user.mfa_enabled || !user.mfa_secret) {
          await this.logAttempt(email, user.id, false, 'MFA_NOT_ENROLLED', ip, deviceId);
          await this.auditLogin(user.id, deviceId, origin, false, 'MFA_NOT_ENROLLED');
          throw new ForbiddenException({ error: 'MFA_REQUIRED_NOT_ENROLLED', detail: 'RF-SEG-005: MFA obrigatório para papéis GLOBAL' });
        }
        if (!totpCode || !verifyTotp(user.mfa_secret, totpCode)) {
          await this.logAttempt(email, user.id, false, 'MFA_INVALID', ip, deviceId);
          await this.auditLogin(user.id, deviceId, origin, false, 'MFA_INVALID');
          throw new UnauthorizedException({ error: 'MFA_INVALID', detail: 'RF-SEG-005: código TOTP inválido ou ausente' });
        }
      }
    }

    // Sucesso: zera contador de falhas.
    await this.db.queryGlobal(`UPDATE wms.user SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await this.logAttempt(email, user.id, true, null, ip, deviceId);
    await this.auditLogin(user.id, deviceId, origin, true, null);

    const assignmentsHash = await this.rbacService.computeAssignmentsHash(user.id);
    const accessToken = this.jwtService.signAccessToken({ sub: user.id, assignments_hash: assignmentsHash, area: user.area });
    const { token: refreshToken, hash: refreshHash } = this.jwtService.generateRefreshToken();
    const ttl = this.jwtService.refreshTtlSeconds(user.area);

    await this.db.queryGlobal(
      `INSERT INTO wms.auth_session (user_id, refresh_token_hash, device_id, assignments_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval, $1)`,
      [user.id, refreshHash, deviceId, assignmentsHash, ttl]
    );

    return { accessToken, refreshToken, mustChangePassword: user.must_change_password, expiresInSeconds: 15 * 60 };
  }

  /** RF-SEG-003: refresh rotativo — a sessão antiga é revogada e substituída por uma nova. */
  async refresh(refreshToken: string, deviceId: string): Promise<LoginResult> {
    const hash = this.jwtService.hashRefreshToken(refreshToken);
    const sessionResult = await this.db.queryGlobal(
      `SELECT s.*, u.area, u.status FROM wms.auth_session s JOIN wms.user u ON u.id = s.user_id
       WHERE s.refresh_token_hash = $1`,
      [hash]
    );
    const session = sessionResult.rows[0];

    if (!session || session.revoked_at || new Date(session.expires_at) < new Date() || session.status !== 'ACTIVE') {
      throw new UnauthorizedException('invalid or expired refresh token');
    }
    if (session.device_id !== deviceId) {
      throw new UnauthorizedException('device mismatch');
    }

    // RF-SEG-003: mudança de atribuição invalida — se o hash guardado na
    // sessão já não bate com o atual, força reautenticação completa.
    const currentHash = await this.rbacService.computeAssignmentsHash(session.user_id);
    if (currentHash !== session.assignments_hash) {
      await this.db.queryGlobal(`UPDATE wms.auth_session SET revoked_at = now() WHERE id = $1`, [session.id]);
      throw new UnauthorizedException('assignments changed — please reauthenticate');
    }

    const accessToken = this.jwtService.signAccessToken({ sub: session.user_id, assignments_hash: currentHash, area: session.area });
    const { token: newRefreshToken, hash: newRefreshHash } = this.jwtService.generateRefreshToken();
    const ttl = this.jwtService.refreshTtlSeconds(session.area);

    const newSession = await this.db.queryGlobal(
      `INSERT INTO wms.auth_session (user_id, refresh_token_hash, device_id, assignments_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval, $1) RETURNING id`,
      [session.user_id, newRefreshHash, deviceId, currentHash, ttl]
    );
    await this.db.queryGlobal(`UPDATE wms.auth_session SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [
      session.id,
      newSession.rows[0].id,
    ]);

    return { accessToken, refreshToken: newRefreshToken, mustChangePassword: false, expiresInSeconds: 15 * 60 };
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = this.jwtService.hashRefreshToken(refreshToken);
    const result = await this.db.queryGlobal(
      `UPDATE wms.auth_session SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL RETURNING user_id`,
      [hash]
    );
    if (result.rows[0]) {
      await this.auditLogin(result.rows[0].user_id, undefined, 'API', true, null, 'LOGOUT');
    }
  }

  /** RF-SEG-002: troca de senha (inclui a obrigatória do primeiro acesso). */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const userResult = await this.db.queryGlobal(`SELECT password_hash FROM wms.user WHERE id = $1`, [userId]);
    const user = userResult.rows[0];
    if (!user || !(await this.passwordService.verify(user.password_hash, oldPassword))) {
      throw new UnauthorizedException('invalid current password');
    }

    const policy = await this.passwordService.getPolicy();
    await this.passwordService.validateAgainstPolicy(newPassword, policy);
    await this.passwordService.checkNotInHistory(userId, newPassword, policy);

    const newHash = await this.passwordService.hash(newPassword);
    await this.db.queryGlobal(
      `UPDATE wms.user SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(), updated_at = now(), updated_by = $1 WHERE id = $1`,
      [userId, newHash]
    );
    await this.db.queryGlobal(`INSERT INTO wms.user_password_history (user_id, password_hash) VALUES ($1, $2)`, [userId, newHash]);
  }

  /** RF-SEG-005: gera o segredo TOTP (ainda não ativo — precisa de confirmMfa). */
  async enrollMfa(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateBase32Secret();
    await this.db.queryGlobal(`UPDATE wms.user SET mfa_secret = $2, mfa_enabled = FALSE WHERE id = $1`, [userId, secret]);
    const userResult = await this.db.queryGlobal(`SELECT email FROM wms.user WHERE id = $1`, [userId]);
    const otpauthUri = `otpauth://totp/WMS:${encodeURIComponent(userResult.rows[0].email)}?secret=${secret}&issuer=WMS`;
    return { secret, otpauthUri };
  }

  /** Confirma o enrollment validando um código TOTP gerado com o segredo pendente. */
  async confirmMfa(userId: string, code: string): Promise<void> {
    const userResult = await this.db.queryGlobal(`SELECT mfa_secret FROM wms.user WHERE id = $1`, [userId]);
    const secret = userResult.rows[0]?.mfa_secret;
    if (!secret || !verifyTotp(secret, code)) {
      throw new BadRequestException('invalid TOTP code');
    }
    await this.db.queryGlobal(`UPDATE wms.user SET mfa_enabled = TRUE WHERE id = $1`, [userId]);
  }

  /** RF-SEG-002: bloqueio de 15 min após N falhas consecutivas. */
  private async registerFailedLogin(userId: string, currentCount: number, policy: { lockoutThreshold: number; lockoutMinutes: number }): Promise<void> {
    const newCount = currentCount + 1;
    if (newCount >= policy.lockoutThreshold) {
      await this.db.queryGlobal(
        `UPDATE wms.user SET failed_login_count = $2, locked_until = now() + ($3 || ' minutes')::interval WHERE id = $1`,
        [userId, newCount, policy.lockoutMinutes]
      );
    } else {
      await this.db.queryGlobal(`UPDATE wms.user SET failed_login_count = $2 WHERE id = $1`, [userId, newCount]);
    }
  }

  /**
   * RN-SEG-032: "login/logout e falhas de autenticação" DEVEM gerar
   * auditoria. warehouse_id fica NULL aqui de propósito — ver a nota de
   * desvio no topo da migration 0019 (login/logout precede qualquer
   * seleção de armazém).
   */
  private async auditLogin(
    userId: string,
    deviceId: string | undefined,
    origin: 'API' | 'PORTAL',
    succeeded: boolean,
    failureReason: string | null,
    action: 'LOGIN' | 'LOGOUT' = 'LOGIN'
  ): Promise<void> {
    await this.auditService.record({
      tenantId: null,
      warehouseId: null,
      userId,
      origin,
      deviceId: deviceId ?? null,
      entity: 'user',
      entityId: userId,
      action,
      reason: failureReason,
      after: { succeeded },
    });
  }

  private async logAttempt(
    email: string,
    userId: string | null,
    succeeded: boolean,
    failureReason: string | null,
    ip: string | undefined,
    deviceId: string | undefined
  ): Promise<void> {
    await this.db.queryGlobal(
      `INSERT INTO wms.login_attempt (email_attempted, user_id, succeeded, failure_reason, ip_address, device_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [email, userId, succeeded, failureReason, ip ?? null, deviceId ?? null]
    );
  }
}
