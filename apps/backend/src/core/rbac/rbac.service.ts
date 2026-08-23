// DOC-12 §4.2 [INVIOLÁVEL] — RN-SEG-011 (resolução multi-dimensional),
// RN-SEG-012 (deny por omissão), RNF-ARQ-010 (app.tenant_ids derivado das
// atribuições vigentes).
//
// [ACHADO ARQUITETURAL] RG-001 (DOC-00) descreve um "modo multi-tenant
// explícito (lista de tenants autorizados)" para staff interno, e
// RN-ARQ-013 fala em app.tenant_ids como lista. Mas TODAS as RLS policies
// já escritas (Sessões 1.5/2A/2B, ~20 migrations) comparam
// `tenant_id = NULLIF(current_setting('app.tenant_ids', true), '')::UUID`
// — igualdade a um ÚNICO UUID, nunca `= ANY(...)`. Reescrever essa
// comparação em toda a base já testada está fora do escopo desta sessão
// ("não refatore código que já passa nos testes"). Esta classe deriva,
// para CADA requisição, um ÚNICO tenant_id validado contra as atribuições
// reais do usuário (fecha o gap de "confiar no tenant_id enviado pelo
// cliente" das Sessões 2A/2B) — não implementa visão simultânea
// multi-cliente em uma mesma query. [DEBITO: suportar de fato
// app.tenant_ids como lista (RLS com = ANY) para o "modo multi-tenant
// explícito" de RG-001, sessão a definir — reescrita de todas as policies
// existentes.]
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service.js';

export interface Assignment {
  assignment_id: string;
  role_id: string;
  role_code: string;
  role_area: 'INTERNAL' | 'CLIENT_PORTAL';
  warehouse_id: string | null;
  client_id: string | null;
}

@Injectable()
export class RbacService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Atribuições vigentes do usuário (papel ATIVO + dentro de valid_from/valid_until). */
  async getActiveAssignments(userId: string): Promise<Assignment[]> {
    const result = await this.db.queryGlobal<Assignment>(
      `SELECT ura.id AS assignment_id, ura.role_id, r.code AS role_code, r.area AS role_area,
              ura.warehouse_id, ura.client_id
       FROM wms.user_role_assignment ura
       JOIN wms.role r ON r.id = ura.role_id
       WHERE ura.user_id = $1
         AND r.status = 'ACTIVE'
         AND (ura.valid_from IS NULL OR ura.valid_from <= CURRENT_DATE)
         AND (ura.valid_until IS NULL OR ura.valid_until >= CURRENT_DATE)`,
      [userId]
    );
    return result.rows;
  }

  /**
   * RN-SEG-011 [INVIOLÁVEL]: um usuário possui a permissão P no contexto
   * (armazém W, cliente C) SE E SOMENTE SE existir atribuição vigente cujo
   * papel contenha P e cujo escopo case com o contexto. Sem curinga
   * (RN-ARQ-013).
   */
  async hasPermission(userId: string, permissionCode: string, context: { warehouseId?: string; clientId?: string } = {}): Promise<boolean> {
    const result = await this.db.queryGlobal(
      `SELECT 1
       FROM wms.user_role_assignment ura
       JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE'
       JOIN wms.role_permission rp ON rp.role_id = ura.role_id
       JOIN wms.permission p ON p.code = rp.permission_code
       WHERE ura.user_id = $1
         AND p.code = $2
         AND (ura.valid_from IS NULL OR ura.valid_from <= CURRENT_DATE)
         AND (ura.valid_until IS NULL OR ura.valid_until >= CURRENT_DATE)
         AND (
           p.scope = 'GLOBAL'
           OR (p.scope = 'WAREHOUSE' AND ura.warehouse_id = $3::uuid)
           OR (p.scope = 'CLIENT_WAREHOUSE' AND ura.warehouse_id = $3::uuid AND ura.client_id = $4::uuid)
         )
       LIMIT 1`,
      [userId, permissionCode, context.warehouseId ?? null, context.clientId ?? null]
    );
    return result.rows.length > 0;
  }

  /**
   * Deriva o(s) client_id(s) que o usuário está autorizado a acessar via
   * atribuições vigentes — usado para validar (não confiar cegamente) o
   * tenant_id que uma requisição HTTP pede para acessar.
   */
  async getAuthorizedClientIds(userId: string): Promise<string[]> {
    const assignments = await this.getActiveAssignments(userId);
    return [...new Set(assignments.filter((a) => a.client_id).map((a) => a.client_id as string))];
  }

  /**
   * DOC-10 RN-SEG-011 — quais client_id um usuário pode ver num CONTEXTO
   * cross-cliente de um armazém (Painel de Operações, RF-PAI-001; centro de
   * alertas, RF-PAI-010) para uma permissão WAREHOUSE-scope específica. Se
   * QUALQUER atribuição vigente que concede `permissionCode` neste armazém
   * tiver `client_id` NULL, o acesso é irrestrito (retorna `null`); caso
   * contrário, restringe ao conjunto de client_ids concedidos (`[]` = a
   * permissão não foi concedida neste armazém — a chamada nem deveria ter
   * passado pelo PermissionGuard, mas devolver "nenhum cliente" é o
   * fail-closed correto de qualquer forma).
   */
  async resolveWarehouseAuthorizedClientIds(userId: string, warehouseId: string, permissionCode: string): Promise<string[] | null> {
    const result = await this.db.queryGlobal<{ client_id: string | null }>(
      `SELECT DISTINCT ura.client_id
       FROM wms.user_role_assignment ura
       JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE'
       JOIN wms.role_permission rp ON rp.role_id = ura.role_id AND rp.permission_code = $3
       WHERE ura.user_id = $1 AND ura.warehouse_id = $2
         AND (ura.valid_from IS NULL OR ura.valid_from <= CURRENT_DATE)
         AND (ura.valid_until IS NULL OR ura.valid_until >= CURRENT_DATE)`,
      [userId, warehouseId, permissionCode]
    );
    if (result.rows.some((r) => r.client_id === null)) return null;
    return result.rows.map((r) => r.client_id as string);
  }

  /**
   * DOC-10 — o JWT (RF-SEG-003) carrega só {sub, assignments_hash, area}, de
   * propósito (nenhum dado de warehouse/client, para não invalidar o token a
   * cada mudança de atribuição). O frontend precisa descobrir em quais
   * armazéns o usuário logado pode operar para escolher o contexto do
   * Painel/Dashboard — esta é a fonte dessa informação, com nome legível
   * (não só UUID) resolvido via join, sem exigir nenhuma permissão além de
   * estar autenticado (toda pessoa pode ver as próprias atribuições).
   */
  async getMyContext(userId: string): Promise<{
    warehouses: Array<{ id: string; code: string; name: string }>;
    clients: Array<{ id: string; code: string; legalName: string; tradeName: string | null }>;
  }> {
    const assignments = await this.getActiveAssignments(userId);
    const warehouseIds = [...new Set(assignments.filter((a) => a.warehouse_id).map((a) => a.warehouse_id as string))];
    const clientIds = [...new Set(assignments.filter((a) => a.client_id).map((a) => a.client_id as string))];

    const warehouses = warehouseIds.length
      ? await this.db.queryGlobal<{ id: string; code: string; name: string }>(
          `SELECT id, code, name FROM wms.warehouse WHERE id = ANY($1::uuid[]) ORDER BY name`,
          [warehouseIds]
        )
      : { rows: [] as Array<{ id: string; code: string; name: string }> };

    // wms.client tem RLS por tenant (tenant_id = o próprio id) — esta busca é
    // necessariamente cross-tenant (os clientes vêm das VÁRIAS atribuições do
    // usuário), então nenhum único app.tenant_ids serve. Mesmo padrão já
    // usado por OperationsBoardService.resolveSlaMap() nesta sessão.
    const clients = clientIds.length
      ? await this.db.transactionAsWorker((client) =>
          client.query<{ id: string; code: string; legal_name: string; trade_name: string | null }>(
            `SELECT id, code, legal_name, trade_name FROM wms.client WHERE id = ANY($1::uuid[]) ORDER BY legal_name`,
            [clientIds]
          )
        )
      : { rows: [] as Array<{ id: string; code: string; legal_name: string; trade_name: string | null }> };

    return {
      warehouses: warehouses.rows,
      clients: clients.rows.map((c) => ({ id: c.id, code: c.code, legalName: c.legal_name, tradeName: c.trade_name })),
    };
  }

  /** RF-SEG-005: MFA TOTP obrigatório para quem possui papel com permissão de escopo GLOBAL. */
  async hasAnyGlobalPermission(userId: string): Promise<boolean> {
    const result = await this.db.queryGlobal(
      `SELECT 1
       FROM wms.user_role_assignment ura
       JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE'
       JOIN wms.role_permission rp ON rp.role_id = ura.role_id
       JOIN wms.permission p ON p.code = rp.permission_code AND p.scope = 'GLOBAL'
       WHERE ura.user_id = $1
         AND (ura.valid_from IS NULL OR ura.valid_from <= CURRENT_DATE)
         AND (ura.valid_until IS NULL OR ura.valid_until >= CURRENT_DATE)
       LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0;
  }

  /** RF-SEG-003: hash estável das atribuições vigentes — muda quando elas mudam. */
  async computeAssignmentsHash(userId: string): Promise<string> {
    const assignments = await this.getActiveAssignments(userId);
    const normalized = assignments
      .map((a) => `${a.role_id}:${a.warehouse_id ?? ''}:${a.client_id ?? ''}`)
      .sort()
      .join('|');
    return createHash('sha256').update(normalized).digest('hex');
  }
}
