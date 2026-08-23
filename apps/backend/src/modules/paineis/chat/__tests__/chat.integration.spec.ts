// DOC-10 §4.4 RF-PAI-030, RN-PAI-031 [INVIOLÁVEL] — chat contra Postgres
// real: salas (armazém-turno idempotente, operação isolada por tenant),
// mensagem imutável, limite de 2.000 caracteres, e a prova estrutural de
// que a superfície do chat não aciona operação alguma.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { OperationFlowService } from '../../../../core/operation-flow/operation-flow.service.js';
import { ChatService } from '../chat.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Chat - DOC-10 §4.4 RF-PAI-030/RN-PAI-031 (Sessão 7A)', () => {
  let testContext: TestContext;
  let chatService: ChatService;
  let operationFlowService: OperationFlowService;
  let warehouseId: string;
  let clientId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    chatService = new ChatService(db, eventsService);
    operationFlowService = new OperationFlowService(db);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém Chat', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    clientId = (await clientService.create({ code: randomClientCode(), legal_name: 'Cliente Chat', cnpj: generateValidCnpj() }, SEED_ACTOR_ID)).id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('RN-PAI-031 [INVIOLÁVEL]: a superfície pública do chat não tem NENHUM método capaz de concluir etapa, aprovar exceção ou movimentar estoque', () => {
    const serviceSource = readFileSync(join(__dirname, '..', 'chat.service.ts'), 'utf-8');
    const controllerSource = readFileSync(join(__dirname, '..', 'chat.controller.ts'), 'utf-8');

    // Prova estrutural (DI), não uma lista finita de nomes de método que
    // poderia ficar desatualizada: nenhuma linha `import { ... }` dos dois
    // arquivos referencia um service capaz de mudar estado operacional. Só
    // as linhas de import contam — os comentários do próprio arquivo CITAM
    // esses nomes para explicar a ausência, o que faria uma busca no texto
    // inteiro falsear positivo.
    const forbidden = ['OperationFlowService', 'StockMovementService', 'OperationalExceptionService', 'PickingTaskService', 'OutboundFlowService'];
    const importLines = (source: string) =>
      source
        .split('\n')
        .filter((line) => line.trim().startsWith('import '))
        .join('\n');

    for (const name of forbidden) {
      expect(importLines(serviceSource)).not.toContain(name);
      expect(importLines(controllerSource)).not.toContain(name);
    }
  });

  it('RF-PAI-030(a): sala armazém-turno é idempotente (uma por armazém)', async () => {
    const first = await chatService.getOrCreateWarehouseShiftRoom(warehouseId, SEED_ACTOR_ID);
    const second = await chatService.getOrCreateWarehouseShiftRoom(warehouseId, SEED_ACTOR_ID);
    expect(second.id).toBe(first.id);
    expect(first.tenant_id).toBeNull();
  });

  it('RF-PAI-030(b): sala de operação herda tenant_id do Fluxo Operacional e é isolada por tenant (RLS)', async () => {
    const { flow } = await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, (client) =>
      operationFlowService.createFlow(client, { tenantId: clientId, warehouseId, entity: 'outbound_order', entityId: crypto.randomUUID(), flowType: 'PEDIDO', stepCodes: ['PEDIDO'] }, SEED_ACTOR_ID)
    );

    const room = await chatService.getOrCreateOperationRoom(flow.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(room.tenant_id).toBe(clientId);
    expect(room.operation_flow_id).toBe(flow.id);

    const second = await chatService.getOrCreateOperationRoom(flow.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(second.id).toBe(room.id);
  });

  it('RF-PAI-030: mensagem imutável, até 2.000 caracteres', async () => {
    const room = await chatService.getOrCreateWarehouseShiftRoom(warehouseId, SEED_ACTOR_ID);
    const message = await chatService.sendMessage({ roomId: room.id as string, senderUserId: SEED_ACTOR_ID, body: 'Turno tranquilo hoje.' });
    expect(message.body).toBe('Turno tranquilo hoje.');

    const tooLong = 'x'.repeat(2001);
    await expect(chatService.sendMessage({ roomId: room.id as string, senderUserId: SEED_ACTOR_ID, body: tooLong })).rejects.toMatchObject({
      response: { error: 'MESSAGE_TOO_LONG' },
    });

    const messages = await chatService.listMessages(room.id as string, null, warehouseId, SEED_ACTOR_ID);
    expect(messages.some((m) => m.id === message.id)).toBe(true);

    // Imutabilidade é garantida no banco (REVOKE UPDATE, migration 0055) —
    // tenta um UPDATE direto e espera falha de permissão.
    await expect(
      testContext.databaseService.query(
        { tenant_id: '00000000-0000-0000-0000-000000000000', user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `UPDATE wms.chat_message SET body = 'editado' WHERE id = $1`,
        [message.id]
      )
    ).rejects.toThrow();
  });
});
