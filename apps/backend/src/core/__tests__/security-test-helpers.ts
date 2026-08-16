// Helpers compartilhados pelos testes de integração do DOC-12.
import { v4 as uuid } from 'uuid';
import { DatabaseService } from '../database/database.service.js';
import { PasswordService } from '../auth/password.service.js';

export const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

export interface CreateTestUserOptions {
  email?: string;
  password?: string;
  area?: 'INTERNAL' | 'CLIENT_PORTAL';
  clientId?: string;
}

export async function createTestUser(
  db: DatabaseService,
  passwordService: PasswordService,
  opts: CreateTestUserOptions = {}
): Promise<{ id: string; email: string; password: string }> {
  const email = opts.email ?? `user-${uuid()}@teste.invalid`;
  const password = opts.password ?? 'Senha-Forte-123!';
  const area = opts.area ?? 'INTERNAL';
  const hash = await passwordService.hash(password);

  const result = await db.queryGlobal(
    `INSERT INTO wms.user (name, email, area, client_id, password_hash, must_change_password, created_by)
     VALUES ('Usuário de Teste', $1, $2, $3, $4, FALSE, $5) RETURNING id`,
    [email, area, opts.clientId ?? null, hash, SEED_ACTOR_ID]
  );
  return { id: result.rows[0].id, email, password };
}

export async function assignRole(
  db: DatabaseService,
  opts: { userId: string; roleCode: string; warehouseId?: string; clientId?: string }
): Promise<void> {
  const roleResult = await db.queryGlobal('SELECT id FROM wms.role WHERE code = $1', [opts.roleCode]);
  if (roleResult.rows.length === 0) throw new Error(`role ${opts.roleCode} not found`);
  await db.queryGlobal(
    `INSERT INTO wms.user_role_assignment (user_id, role_id, warehouse_id, client_id, created_by)
     VALUES ($1, $2, $3, $4, $1)`,
    [opts.userId, roleResult.rows[0].id, opts.warehouseId ?? null, opts.clientId ?? null]
  );
}

export async function grantApprovalAuthority(
  db: DatabaseService,
  opts: { roleCode: string; exceptionType: string; warehouseId: string; maxQty?: number | null; maxValueBrl?: number | null }
): Promise<void> {
  const roleResult = await db.queryGlobal('SELECT id FROM wms.role WHERE code = $1', [opts.roleCode]);
  await db.queryGlobal(
    `INSERT INTO wms.approval_authority (role_id, exception_type, warehouse_id, max_qty, max_value_brl, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [roleResult.rows[0].id, opts.exceptionType, opts.warehouseId, opts.maxQty ?? null, opts.maxValueBrl ?? null, SEED_ACTOR_ID]
  );
}
