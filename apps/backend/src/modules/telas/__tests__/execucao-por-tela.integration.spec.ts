// DOC-17 §6 (Sessão 10E) — RN-TEL-010 [INVIOLÁVEL] (Modo de Execução),
// RN-TEL-012 item 4 (permissão própria) e RD-TEL-004 (`execution_channel`).
//
// Inclui a regressão da correção de raiz feita nesta sessão: `app_parameter`
// não tinha chave única, então os `ON CONFLICT DO NOTHING` de 14 migrations
// não protegiam nada e uma reexecução duplicaria parâmetro em silêncio.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { ExecutionModeService } from '../execution-mode/execution-mode.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../core/__tests__/security-test-helpers.js';

describe('DOC-17 §6 — Sessão 10E: Execução por Tela (RN-TEL-010/012, RD-TEL-004)', () => {
  let testContext: TestContext;
  let service: ExecutionModeService;
  let clientId: string;
  let warehouseId: string;
  let ctx: { tenant_id: string; user_id: string; warehouse_id: string };
  /** LIDER_TURNO — tem TEL.EXECUCAO_TELA (migration 0079). */
  let operadorTela: { id: string };
  /** OPERADOR_EMPILHADEIRA — NÃO tem TEL.EXECUCAO_TELA. */
  let operadorColetor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const rbacService = new RbacService(db);
    service = new ExecutionModeService(db, auditService, rbacService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    const passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém execução por tela', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente execução por tela', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FIFO' }, SEED_ACTOR_ID);
    ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };

    operadorTela = await createTestUser(db, passwordService);
    operadorColetor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: operadorTela.id, roleCode: 'LIDER_TURNO', warehouseId, clientId });
    await assignRole(db, { userId: operadorColetor.id, roleCode: 'OPERADOR_EMPILHADEIRA', warehouseId, clientId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('padrão do sistema é COLETOR — aplicar o DOC-17 não muda o comportamento de quem já operava', async () => {
    expect(await service.resolveMode(ctx)).toBe('COLETOR');
  });

  it('RN-TEL-010: em modo COLETOR, execução por tela é rejeitada', async () => {
    await service.setMode(ctx, 'COLETOR', null, SEED_ACTOR_ID);
    await expect(service.assertCanExecute({ ctx, channel: 'TELA', actorUserId: operadorTela.id })).rejects.toMatchObject({
      response: { error: 'EXECUTION_CHANNEL_NOT_ALLOWED' },
    });
    // ... e o coletor segue livre.
    await expect(service.assertCanExecute({ ctx, channel: 'COLETOR', actorUserId: operadorColetor.id })).resolves.toBeUndefined();
  });

  it('RN-TEL-010: em modo TELA, o COLETOR é rejeitado e o FORMULARIO passa (a regra diz "telas E formulários")', async () => {
    await service.setMode(ctx, 'TELA', null, SEED_ACTOR_ID);
    await expect(service.assertCanExecute({ ctx, channel: 'COLETOR', actorUserId: operadorColetor.id })).rejects.toMatchObject({
      response: { error: 'EXECUTION_CHANNEL_NOT_ALLOWED' },
    });
    await expect(service.assertCanExecute({ ctx, channel: 'TELA', actorUserId: operadorTela.id })).resolves.toBeUndefined();
    await expect(service.assertCanExecute({ ctx, channel: 'FORMULARIO', actorUserId: operadorTela.id })).resolves.toBeUndefined();
  });

  it('RN-TEL-012 item 4: sem TEL.EXECUCAO_TELA a execução por tela é negada mesmo com o modo permitindo', async () => {
    await service.setMode(ctx, 'HIBRIDO', null, SEED_ACTOR_ID);
    await expect(service.assertCanExecute({ ctx, channel: 'TELA', actorUserId: operadorColetor.id })).rejects.toMatchObject({
      response: { error: 'SCREEN_EXECUTION_NOT_PERMITTED' },
    });
    // Mesmo usuário, mesmo modo, canal coletor: passa. A permissão é do CANAL.
    await expect(service.assertCanExecute({ ctx, channel: 'COLETOR', actorUserId: operadorColetor.id })).resolves.toBeUndefined();
  });

  it('RN-TEL-010 por TIPO DE OPERAÇÃO: a chave específica vence a genérica', async () => {
    await service.setMode(ctx, 'COLETOR', null, SEED_ACTOR_ID);
    await service.setMode(ctx, 'TELA', 'PUTAWAY', SEED_ACTOR_ID);

    expect(await service.resolveMode(ctx)).toBe('COLETOR');
    expect(await service.resolveMode(ctx, 'PUTAWAY')).toBe('TELA');
    // Operação sem chave própria herda a genérica.
    expect(await service.resolveMode(ctx, 'PICKING')).toBe('COLETOR');
  });

  it('RN-TEL-010 [INVIOLÁVEL]: tarefa iniciada no COLETOR não pode ser concluída por TELA (dupla contagem)', async () => {
    await service.setMode(ctx, 'HIBRIDO', null, SEED_ACTOR_ID);
    const taskId = await createStartedPutawayTask('COLETOR');

    await expect(
      service.assertCanExecute({ ctx, channel: 'TELA', taskEntity: 'putaway_task', taskId, actorUserId: operadorTela.id })
    ).rejects.toMatchObject({ response: { error: 'EXECUTION_CHANNEL_SWITCH_DENIED' } });

    // Continuar no MESMO canal segue permitido.
    await expect(
      service.assertCanExecute({ ctx, channel: 'COLETOR', taskEntity: 'putaway_task', taskId, actorUserId: operadorColetor.id })
    ).resolves.toBeUndefined();
  });

  it('a trava só vale depois de INICIADA: tarefa CREATED aceita qualquer canal', async () => {
    await service.setMode(ctx, 'HIBRIDO', null, SEED_ACTOR_ID);
    const taskId = await createStartedPutawayTask('COLETOR', 'CREATED');

    await expect(
      service.assertCanExecute({ ctx, channel: 'TELA', taskEntity: 'putaway_task', taskId, actorUserId: operadorTela.id })
    ).resolves.toBeUndefined();
  });

  it('RD-TEL-004: stampChannel grava o canal na tarefa', async () => {
    const taskId = await createStartedPutawayTask('COLETOR', 'CREATED');
    await service.stampChannel(ctx, 'putaway_task', taskId, 'TELA');

    const row = await testContext.databaseService.query({ ...ctx }, `SELECT execution_channel FROM wms.putaway_task WHERE id = $1`, [taskId]);
    expect(row.rows[0].execution_channel).toBe('TELA');
  });

  it('RD-TEL-004: stock_movement tem execution_channel com default COLETOR (histórico lido corretamente)', async () => {
    const col = await testContext.databaseService.queryGlobal(
      `SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = 'wms' AND table_name = 'stock_movement' AND column_name = 'execution_channel'`
    );
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0].column_default).toContain('COLETOR');
    expect(col.rows[0].is_nullable).toBe('NO');
  });

  it('setMode rejeita modo fora do catálogo fechado', async () => {
    await expect(service.setMode(ctx, 'QUALQUER', null, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'INVALID_EXECUTION_MODE' } });
  });

  it('setMode é idempotente e NÃO duplica parâmetro (regressão: app_parameter não tinha chave única)', async () => {
    await service.setMode(ctx, 'TELA', null, SEED_ACTOR_ID);
    await service.setMode(ctx, 'HIBRIDO', null, SEED_ACTOR_ID);
    await service.setMode(ctx, 'COLETOR', null, SEED_ACTOR_ID);

    const rows = await testContext.databaseService.query(
      { ...ctx },
      `SELECT value FROM wms.app_parameter WHERE name = 'TEL.MODO_EXECUCAO' AND scope = 'WAREHOUSE' AND warehouse_id = $1`,
      [warehouseId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].value).toBe('COLETOR');
  });

  it('o índice único de app_parameter existe e barra duplicata de verdade', async () => {
    const idx = await testContext.databaseService.queryGlobal(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'wms' AND tablename = 'app_parameter' AND indexname = 'uq_app_parameter_scope_name_target'`
    );
    expect(idx.rows).toHaveLength(1);

    // Prova funcional, autossuficiente (o harness limpa app_parameter após
    // as migrations, então não dá para contar com a linha do seed): inserir
    // a MESMA chave GLOBAL duas vezes tem de falhar na segunda.
    //
    // O caso GLOBAL é o que mais importa: warehouse_id e client_id são NULL,
    // e sem `NULLS NOT DISTINCT` o índice não pegaria justamente a maioria
    // das linhas da tabela.
    const name = 'TEL.TESTE_UNICIDADE_GLOBAL';
    await testContext.databaseService.queryGlobal(`INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', $1, 'A')`, [name]);
    await expect(testContext.databaseService.queryGlobal(`INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', $1, 'B')`, [name])).rejects.toMatchObject({
      code: '23505',
    });
  });

  /** Cria uma tarefa de putaway crua, com canal e status controlados — o foco aqui é a guarda, não o fluxo de recebimento. */
  async function createStartedPutawayTask(channel: string, status = 'ASSIGNED'): Promise<string> {
    const db = testContext.databaseService;
    const pallet = await db.query(
      { ...ctx },
      `INSERT INTO wms.pallet (tenant_id, lpn, pallet_type, created_by) VALUES ($1, $2, 'PBR', $3) RETURNING id`,
      [clientId, String(Math.floor(Math.random() * 1e17)).padStart(18, '0'), SEED_ACTOR_ID]
    );
    const task = await db.query(
      { ...ctx },
      `INSERT INTO wms.putaway_task (tenant_id, warehouse_id, pallet_id, inbound_order_id, priority, status, execution_channel, created_by)
       VALUES ($1,$2,$3,NULL,100,$4,$5,$6) RETURNING id`,
      [clientId, warehouseId, pallet.rows[0].id, status, channel, SEED_ACTOR_ID]
    );
    return task.rows[0].id;
  }
});
