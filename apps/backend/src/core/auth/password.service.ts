// DOC-12 RF-SEG-002 — senhas com Argon2id; política mínima lida de
// app_parameter (chaves SEG.PASSWORD_*, escopo GLOBAL, migration 0021).
import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DatabaseService } from '../database/database.service.js';

export interface PasswordPolicy {
  minLength: number;
  minClasses: number;
  lockoutMinutes: number;
  lockoutThreshold: number;
  historyCount: number;
}

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 10,
  minClasses: 3,
  lockoutMinutes: 15,
  lockoutThreshold: 5,
  historyCount: 5,
};

// app_parameter (migration 0004) exige ALGUM contexto de tenant setado
// mesmo para linhas GLOBAL (RLS da migration 0004) — usado para leituras
// de política de senha que acontecem ANTES de qualquer autenticação
// (ex.: validar a senha no cadastro de um novo usuário).
const SYSTEM_CONTEXT = { tenant_id: '00000000-0000-0000-0000-000000000001', user_id: '00000000-0000-0000-0000-000000000001' };

@Injectable()
export class PasswordService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  async getPolicy(): Promise<PasswordPolicy> {
    const result = await this.db.query(
      SYSTEM_CONTEXT,
      `SELECT name, value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name LIKE 'SEG.PASSWORD_%'`
    );
    const rows: Record<string, string> = Object.fromEntries(result.rows.map((r) => [r.name, r.value]));
    return {
      minLength: parseInt(rows['SEG.PASSWORD_MIN_LENGTH'] ?? String(DEFAULT_POLICY.minLength), 10),
      minClasses: parseInt(rows['SEG.PASSWORD_MIN_CLASSES'] ?? String(DEFAULT_POLICY.minClasses), 10),
      lockoutMinutes: parseInt(rows['SEG.PASSWORD_LOCKOUT_MINUTES'] ?? String(DEFAULT_POLICY.lockoutMinutes), 10),
      lockoutThreshold: parseInt(rows['SEG.PASSWORD_LOCKOUT_THRESHOLD'] ?? String(DEFAULT_POLICY.lockoutThreshold), 10),
      historyCount: parseInt(rows['SEG.PASSWORD_HISTORY_COUNT'] ?? String(DEFAULT_POLICY.historyCount), 10),
    };
  }

  /** Conta classes de caractere presentes: minúsculas, maiúsculas, dígitos, símbolos. */
  countCharacterClasses(password: string): number {
    let classes = 0;
    if (/[a-z]/.test(password)) classes++;
    if (/[A-Z]/.test(password)) classes++;
    if (/[0-9]/.test(password)) classes++;
    if (/[^a-zA-Z0-9]/.test(password)) classes++;
    return classes;
  }

  async validateAgainstPolicy(password: string, policy?: PasswordPolicy): Promise<void> {
    const p = policy ?? (await this.getPolicy());
    const violations: string[] = [];
    if (password.length < p.minLength) {
      violations.push(`RF-SEG-002: senha deve ter no mínimo ${p.minLength} caracteres`);
    }
    if (this.countCharacterClasses(password) < p.minClasses) {
      violations.push(`RF-SEG-002: senha deve conter no mínimo ${p.minClasses} classes de caracteres (minúscula/maiúscula/dígito/símbolo)`);
    }
    if (violations.length > 0) {
      throw new BadRequestException({ error: 'PASSWORD_POLICY_VIOLATION', violations });
    }
  }

  /** RF-SEG-002: histórico das últimas N senhas — impede reuso. */
  async checkNotInHistory(userId: string, newPassword: string, policy?: PasswordPolicy): Promise<void> {
    const p = policy ?? (await this.getPolicy());
    const result = await this.db.queryGlobal(
      `SELECT password_hash FROM wms.user_password_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, p.historyCount]
    );
    for (const row of result.rows) {
      if (await this.verify(row.password_hash, newPassword)) {
        throw new BadRequestException({
          error: 'PASSWORD_REUSE_DENIED',
          detail: `RF-SEG-002: senha não pode repetir nenhuma das últimas ${p.historyCount} senhas`,
        });
      }
    }
  }
}
