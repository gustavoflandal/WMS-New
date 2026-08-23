// Script ÚNICO e DESCARTÁVEL — popula o banco de desenvolvimento (o MESMO
// que os containers de infra/docker-compose.yml usam, via .env da raiz) com
// um operador de campo real + tarefas de cada tipo (T2-T6), só para
// capturar screenshots reais das telas da Sessão COL-2B. Não faz parte do
// produto, não é testado, roda uma vez via `npx tsx` e é apagado ao final da
// sessão (ver relatório).
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '../../.env') });

import { DatabaseService } from '../src/core/database/database.service.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { EventsService } from '../src/core/events/events.service.js';
import { PasswordService } from '../src/core/auth/password.service.js';
import { RbacService } from '../src/core/rbac/rbac.service.js';
import { ApprovalAuthorityService } from '../src/core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../src/core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../src/core/operation-flow/operation-flow.service.js';
import { DocumentNumberingService } from '../src/modules/cadastro/document-numbering/document-numbering.service.js';
import { WarehouseService } from '../src/modules/cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../src/modules/cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../src/modules/cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ZoneService } from '../src/modules/cadastro/zone/zone.service.js';
import { ProductService } from '../src/modules/cadastro/product/product.service.js';
import { PutawayEngineService } from '../src/modules/recebimento/putaway/putaway-engine.service.js';
import { StockMovementService } from '../src/modules/estoque/movement/stock-movement.service.js';
import { InboundOrderService } from '../src/modules/recebimento/inbound-order/inbound-order.service.js';
import { CheckingService } from '../src/modules/recebimento/checking/checking.service.js';
import { InventoryPlanningService } from '../src/modules/estoque/inventory/inventory-planning.service.js';
import { FileStorageService } from '../src/core/storage/file-storage.service.js';
import { generateValidCnpj } from '../src/modules/cadastro/__tests__/test-helpers.js';

const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

async function main(): Promise<void> {
  const db = new DatabaseService();
  await db.onModuleInit();

  const auditService = new AuditService(db);
  const eventsService = new EventsService();
  const passwordService = new PasswordService(db);
  const rbacService = new RbacService(db);
  const approvalAuthorityService = new ApprovalAuthorityService(db);
  const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
  const operationFlowService = new OperationFlowService(db);
  const documentNumberingService = new DocumentNumberingService(db);
  const warehouseService = new WarehouseService(db, auditService);
  const clientService = new ClientService(db, auditService);
  const settingsService = new ClientWarehouseSettingsService(db, auditService);
  const zoneService = new ZoneService(db, auditService);
  const productService = new ProductService(db, auditService);
  const putawayEngineService = new PutawayEngineService(db);
  const stockMovementService = new StockMovementService(db);
  const fileStorageService = new FileStorageService({ get: (k: string, d?: any) => process.env[k] ?? d } as any);
  fileStorageService.onModuleInit();
  const inboundOrderService = new InboundOrderService(db, eventsService, auditService, operationalExceptionService, operationFlowService, fileStorageService, documentNumberingService);
  const checkingService = new CheckingService(db, eventsService, auditService, operationalExceptionService, operationFlowService);
  const inventoryPlanningService = new InventoryPlanningService(db, eventsService, documentNumberingService);

  const existingWarehouse = await db.queryGlobal(`SELECT * FROM wms.warehouse WHERE code = 'COL2BS'`);
  const warehouse =
    existingWarehouse.rows[0] ??
    (await warehouseService.create({ code: 'COL2BS', name: 'Armazém Screenshots COL-2B', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID));

  const existingClient = await db.transactionAsWorker((c) => c.query(`SELECT * FROM wms.client WHERE code = 'CCOL2BSHOT'`));
  const client = existingClient.rows[0] ?? (await clientService.create({ code: 'CCOL2BSHOT', legal_name: 'Cliente Screenshots COL-2B', cnpj: generateValidCnpj() }, SEED_ACTOR_ID));

  const existingSettings = await db.query({ tenant_id: client.id, user_id: SEED_ACTOR_ID, warehouse_id: warehouse.id }, `SELECT 1 FROM wms.client_warehouse_settings WHERE tenant_id = $1 AND warehouse_id = $2`, [client.id, warehouse.id]);
  if (existingSettings.rows.length === 0) {
    await settingsService.create({ tenant_id: client.id, warehouse_id: warehouse.id, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true }, SEED_ACTOR_ID);
  }

  const existingZone = await db.queryGlobal(`SELECT * FROM wms.zone WHERE warehouse_id = $1 AND code = 'STO'`, [warehouse.id]);
  const zone = existingZone.rows[0] ?? (await zoneService.create({ warehouse_id: warehouse.id, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID));

  const email = 'operador.col2b@screenshots.invalid';
  const password = 'Senha-Forte-123!';
  const existingUser = await db.queryGlobal(`SELECT id FROM wms.user WHERE email = $1`, [email]);
  let userId: string;
  if (existingUser.rows.length > 0) {
    userId = existingUser.rows[0].id;
  } else {
    const hash = await passwordService.hash(password);
    const userResult = await db.queryGlobal(
      `INSERT INTO wms.user (name, email, area, client_id, password_hash, must_change_password, created_by)
       VALUES ('Operador Screenshots', $1, 'INTERNAL', NULL, $2, FALSE, $3) RETURNING id`,
      [email, hash, SEED_ACTOR_ID]
    );
    userId = userResult.rows[0].id;
    const roleResult = await db.queryGlobal(`SELECT id FROM wms.role WHERE code = 'OPERADOR_EMPILHADEIRA'`);
    await db.queryGlobal(
      `INSERT INTO wms.user_role_assignment (user_id, role_id, warehouse_id, client_id, created_by) VALUES ($1,$2,$3,$4,$1)`,
      [userId, roleResult.rows[0].id, warehouse.id, client.id]
    );
  }

  async function createLocation(code: string) {
    const existing = await db.queryGlobal(`SELECT * FROM wms.location WHERE warehouse_id = $1 AND aisle = 'A1' AND module = $2`, [warehouse.id, code]);
    if (existing.rows.length > 0) return existing.rows[0];
    const result = await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1',$3,'00','01','STORAGE',5000,100,5,5,'ACTIVE',$4) RETURNING *`,
      [warehouse.id, zone.id, code, SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  async function createProduct(sku: string, description: string) {
    const existing = await db.query({ tenant_id: client.id, user_id: SEED_ACTOR_ID }, `SELECT * FROM wms.product WHERE tenant_id = $1 AND sku = $2`, [client.id, sku]);
    if (existing.rows.length > 0) return existing.rows[0];
    return productService.create({ tenant_id: client.id, sku, description, species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);
  }

  const ctx = { tenant_id: client.id, user_id: SEED_ACTOR_ID, warehouse_id: warehouse.id };

  // ---- T2 Putaway: pallet + putaway_task ASSIGNED ----
  const productPutaway = await createProduct('SKU-PUT-01', 'Caixa de parafusos M8');
  const locPutawayDest = await createLocation('001');
  const lpn = '1' + Date.now().toString().padStart(13, '0') + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  const palletResult = await db.query(ctx, `INSERT INTO wms.pallet (tenant_id, lpn, pallet_type, status, created_by) VALUES ($1,$2,'PBR','IN_RECEIVING',$3) RETURNING *`, [client.id, lpn, SEED_ACTOR_ID]);
  const pallet = palletResult.rows[0];
  await db.query(ctx, `INSERT INTO wms.pallet_content (tenant_id, pallet_id, product_id, qty, created_by) VALUES ($1,$2,$3,$4,$5)`, [client.id, pallet.id, productPutaway.id, 120, SEED_ACTOR_ID]);
  await db.query(
    ctx,
    `INSERT INTO wms.putaway_task (tenant_id, warehouse_id, pallet_id, location_id_designated, assigned_to_user_id, status, created_by) VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6) RETURNING id`,
    [client.id, warehouse.id, pallet.id, locPutawayDest.id, userId, SEED_ACTOR_ID]
  );

  // ---- T6 Reposição: replenishment_task ASSIGNED ----
  const productRepo = await createProduct('SKU-REP-01', 'Fita adesiva 48mm');
  const locRepoOrigin = await createLocation('101');
  const locRepoDest = await createLocation('102');
  const existingBalanceRepo = await db.query(ctx, `SELECT 1 FROM wms.stock_balance WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location_id=$4`, [client.id, warehouse.id, productRepo.id, locRepoOrigin.id]);
  if (existingBalanceRepo.rows.length === 0) {
    await db.transaction(ctx, async (dbClient) => {
      await dbClient.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
      await dbClient.query(
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,80,$5)`,
        [client.id, warehouse.id, productRepo.id, locRepoOrigin.id, SEED_ACTOR_ID]
      );
    });
  }
  await db.query(
    ctx,
    `INSERT INTO wms.replenishment_task (tenant_id, warehouse_id, product_id, trigger_type, location_id_origin, location_id_destination, qty, assigned_to_user_id, status, created_by)
     VALUES ($1,$2,$3,'MANUAL',$4,$5,20,$6,'ASSIGNED',$7)`,
    [client.id, warehouse.id, productRepo.id, locRepoOrigin.id, locRepoDest.id, userId, SEED_ACTOR_ID]
  );

  // ---- T3 Picking: NÃO seedado neste script — picking_task exige outbound_order/
  // outbound_order_item/stock_reservation reais (pipeline de onda completo),
  // fora do custo-benefício deste seed avulso. A tela T3 será capturada no
  // estado real "tarefa não encontrada" (estado genuíno, não fabricado).

  // ---- T4 Conferência: Ordem -> AT_DOCK -> UNLOADING -> CHECKING (item CHECKING_PENDING) ----
  const productCheck = await createProduct('SKU-CHK-01', 'Pallet de embalagens');
  const created = await inboundOrderService.createManual({ tenantId: client.id, warehouseId: warehouse.id, items: [{ productId: productCheck.id, qtyExpected: 50 }] }, SEED_ACTOR_ID);
  await db.transaction(ctx, async (dbClient) => {
    await dbClient.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
    const flow = await dbClient.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
    await operationFlowService.completeStep(dbClient, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
  });
  await checkingService.startUnloading(created.order.id, client.id, warehouse.id, SEED_ACTOR_ID);
  await checkingService.startChecking(created.order.id, client.id, warehouse.id, SEED_ACTOR_ID);

  // ---- T5 Contagem: inventário POR_ENDERECO IN_PROGRESS (célula PENDING) ----
  const productCount = await createProduct('SKU-CNT-01', 'Rolo de plástico bolha');
  const locCount = await createLocation('301');
  const existingBalanceCount = await db.query(ctx, `SELECT 1 FROM wms.stock_balance WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location_id=$4`, [client.id, warehouse.id, productCount.id, locCount.id]);
  if (existingBalanceCount.rows.length === 0) {
    await db.transaction(ctx, async (dbClient) => {
      await dbClient.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
      await dbClient.query(
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,40,$5)`,
        [client.id, warehouse.id, productCount.id, locCount.id, SEED_ACTOR_ID]
      );
    });
  }
  const planned = await inventoryPlanningService.plan({ tenantId: client.id, warehouseId: warehouse.id, countType: 'POR_ENDERECO', locationIds: [locCount.id], actorUserId: SEED_ACTOR_ID });
  await inventoryPlanningService.start(client.id, warehouse.id, planned.headerId, SEED_ACTOR_ID);

  console.log('=== SEED CONCLUÍDO ===');
  console.log('warehouseId:', warehouse.id);
  console.log('warehouseCode:', warehouse.code);
  console.log('clientId:', client.id);
  console.log('email:', email);
  console.log('password:', password);

  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
