// DOC-12 §4.3 — RD-SEG-020 (approval_authority), RN-SEG-021 (aplicação da alçada).
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export interface Authority {
  maxQty: number | null; // null = sem limite
  maxValueBrl: number | null;
}

@Injectable()
export class ApprovalAuthorityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * RN-SEG-021: alçada do usuário (maior entre todos os papéis ativos dele
   * com approval_authority configurada para este exception_type/armazém).
   * Retorna null se o usuário não tem NENHUMA alçada configurada ali.
   */
  async getUserAuthority(userId: string, exceptionType: string, warehouseId: string): Promise<Authority | null> {
    const result = await this.db.queryGlobal<{ max_qty: string | null; max_value_brl: string | null }>(
      `SELECT aa.max_qty, aa.max_value_brl
       FROM wms.user_role_assignment ura
       JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE'
       JOIN wms.approval_authority aa ON aa.role_id = ura.role_id AND aa.exception_type = $2 AND aa.warehouse_id = $3
       WHERE ura.user_id = $1
         AND (ura.warehouse_id IS NULL OR ura.warehouse_id = $3)
         AND (ura.valid_from IS NULL OR ura.valid_from <= CURRENT_DATE)
         AND (ura.valid_until IS NULL OR ura.valid_until >= CURRENT_DATE)`,
      [userId, exceptionType, warehouseId]
    );
    if (result.rows.length === 0) return null;

    // "sem limite" (NULL) em qualquer papel do usuário vence — pega o maior.
    let maxQty: number | null = 0;
    let maxValueBrl: number | null = 0;
    for (const row of result.rows) {
      if (row.max_qty === null) {
        maxQty = null;
      } else if (maxQty !== null) {
        maxQty = Math.max(maxQty, Number(row.max_qty));
      }
      if (row.max_value_brl === null) {
        maxValueBrl = null;
      } else if (maxValueBrl !== null) {
        maxValueBrl = Math.max(maxValueBrl, Number(row.max_value_brl));
      }
    }
    return { maxQty, maxValueBrl };
  }

  /** RN-SEG-021: a alçada do usuário cobre qty/valueBrl da exceção? */
  authorityCovers(authority: Authority, qty: number | null, valueBrl: number | null): boolean {
    if (qty !== null && authority.maxQty !== null && qty > authority.maxQty) return false;
    if (valueBrl !== null && authority.maxValueBrl !== null && valueBrl > authority.maxValueBrl) return false;
    return true;
  }

  /**
   * Maior alçada JÁ CONFIGURADA no armazém para este exception_type,
   * independente de quem — usado para decidir escalonamento (RN-SEG-021:
   * "SE a exceção exceder TODAS as alçadas configuradas do armazém").
   */
  async getMaxConfiguredAuthority(exceptionType: string, warehouseId: string): Promise<Authority | null> {
    const result = await this.db.queryGlobal<{ max_qty: string | null; max_value_brl: string | null }>(
      `SELECT max_qty, max_value_brl FROM wms.approval_authority WHERE exception_type = $1 AND warehouse_id = $2`,
      [exceptionType, warehouseId]
    );
    if (result.rows.length === 0) return null;

    let maxQty: number | null = 0;
    let maxValueBrl: number | null = 0;
    for (const row of result.rows) {
      if (row.max_qty === null) maxQty = null;
      else if (maxQty !== null) maxQty = Math.max(maxQty, Number(row.max_qty));
      if (row.max_value_brl === null) maxValueBrl = null;
      else if (maxValueBrl !== null) maxValueBrl = Math.max(maxValueBrl, Number(row.max_value_brl));
    }
    return { maxQty, maxValueBrl };
  }

  /** SE nenhuma alçada configurada cobre a exceção, ela deve escalar (RN-SEG-021). */
  async exceedsAllConfiguredAuthorities(exceptionType: string, warehouseId: string, qty: number | null, valueBrl: number | null): Promise<boolean> {
    const max = await this.getMaxConfiguredAuthority(exceptionType, warehouseId);
    if (!max) return true; // nenhuma alçada configurada no armazém = excede tudo
    return !this.authorityCovers(max, qty, valueBrl);
  }
}
