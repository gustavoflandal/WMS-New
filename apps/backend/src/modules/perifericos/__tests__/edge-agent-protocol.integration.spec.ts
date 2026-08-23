// DOC-11 §6 — Critérios de aceite (Gherkin) do protocolo do Edge Agent,
// contra um backend HTTP+WebSocket REAL (app.listen(0), mesmo padrão de
// actor-identity-e2e.integration.spec.ts) e o simulador de referência real
// (@wms/edge-agent — Entregável 7: "não é mock, é um agent real falando o
// protocolo real, com dispositivos simulados").
import { Test } from '@nestjs/testing';
import { INestApplication, Module } from '@nestjs/common';
import { AddressInfo } from 'net';
import { EdgeAgentSimulator } from '@wms/edge-agent';
import { DatabaseModule } from '../../../core/database/database.module.js';
import { RbacModule } from '../../../core/rbac/rbac.module.js';
import { AuditModule } from '../../../core/audit/audit.module.js';
import { EventsModule } from '../../../core/events/events.module.js';
import { PerifericosModule } from '../perifericos.module.js';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { EdgeAgentAdminService } from '../devices/edge-agent-admin.service.js';
import { PeripheralDeviceService } from '../devices/peripheral-device.service.js';
import { PeripheralJobService } from '../jobs/peripheral-job.service.js';
import { LabelTemplateService } from '../labels/label-template.service.js';
import { LprService } from '../lpr/lpr.service.js';
import { EdgeAgentConnectionRegistry } from '../gateway/edge-agent-connection.registry.js';
import { buildLpnElementString } from '../gs1/gs1.util.js';
import { generateValidCnpj, randomWarehouseCode } from '../../cadastro/__tests__/test-helpers.js';
import { SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';

@Module({ imports: [DatabaseModule, RbacModule, AuditModule, EventsModule, PerifericosModule] })
class TestAppModule {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(peripheralJobService: PeripheralJobService, jobId: string, states: string[], timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let job = await peripheralJobService.findById(jobId);
  while (!states.includes(job.state) && Date.now() < deadline) {
    await sleep(50);
    job = await peripheralJobService.findById(jobId);
  }
  return job;
}

describe('DOC-11 §6 — Protocolo do Edge Agent (job real via WebSocket + simulador de referência)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let baseUrl: string;
  let wsUrl: string;

  let edgeAgentAdminService: EdgeAgentAdminService;
  let peripheralDeviceService: PeripheralDeviceService;
  let peripheralJobService: PeripheralJobService;
  let labelTemplateService: LabelTemplateService;
  let lprService: LprService;
  let registry: EdgeAgentConnectionRegistry;

  let warehouseId: string;
  let printerDeviceCode: string;
  let cancelaDeviceCode: string;
  let lprDeviceCode: string;
  let edgeAgentId: string;
  let deviceToken: string;

  const LPN = '129000000000012346'; // exemplo normativo DOC-02/DOC-11

  beforeAll(async () => {
    const testModule = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = testModule.createNestApplication();
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = baseUrl;

    db = testModule.get(DatabaseService);
    const auditService = testModule.get(AuditService);
    const warehouseService = new WarehouseService(db, auditService);
    edgeAgentAdminService = testModule.get(EdgeAgentAdminService);
    peripheralDeviceService = testModule.get(PeripheralDeviceService);
    peripheralJobService = testModule.get(PeripheralJobService);
    labelTemplateService = testModule.get(LabelTemplateService);
    lprService = testModule.get(LprService);
    registry = testModule.get(EdgeAgentConnectionRegistry);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém DOC-11', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;

    const paired = await edgeAgentAdminService.registerAgent({ warehouseId, deviceName: 'Agent DOC-11 teste', actorUserId: SEED_ACTOR_ID });
    edgeAgentId = paired.edgeAgentId;
    deviceToken = paired.token;

    printerDeviceCode = 'ZBR-DOC11-01';
    cancelaDeviceCode = 'CANCELA-DOC11-01';
    lprDeviceCode = 'LPR-DOC11-01';
    await peripheralDeviceService.registerDevice({ warehouseId, edgeAgentId, deviceCode: printerDeviceCode, function: 'IMPRESSORA_ETIQUETA', driverCode: 'ZPL_TCP', actorUserId: SEED_ACTOR_ID });
    await peripheralDeviceService.registerDevice({ warehouseId, edgeAgentId, deviceCode: cancelaDeviceCode, function: 'CANCELA', driverCode: 'RELE_IP', actorUserId: SEED_ACTOR_ID });
    await peripheralDeviceService.registerDevice({ warehouseId, edgeAgentId, deviceCode: lprDeviceCode, function: 'LPR', driverCode: 'LPR_PUSH', actorUserId: SEED_ACTOR_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  function baseLpnFields(): Record<string, string> {
    return {
      gs1_element_string: buildLpnElementString(LPN),
      lpn: LPN,
      client_code: 'ACME01',
      product_desc_or_misto: 'Produto teste DOC-11',
      batch_code: 'L2026001',
      expiration_date: '2026-12-31',
      qty: '10',
      datetime: new Date().toISOString(),
      warehouse_code: 'WH01',
    };
  }

  async function printerDevice() {
    return peripheralDeviceService.findByCode(printerDeviceCode);
  }
  async function cancelaDevice() {
    return peripheralDeviceService.findByCode(cancelaDeviceCode);
  }

  describe('Conectado (agent ONLINE via WebSocket real)', () => {
    let simulator: EdgeAgentSimulator;

    beforeAll(async () => {
      simulator = new EdgeAgentSimulator({ backendUrl: wsUrl, token: deviceToken, heartbeatIntervalMs: 60000, telemetryIntervalMs: 60000 });
      await simulator.connect();
    });

    afterAll(async () => {
      await simulator.disconnect();
    });

    it('Cenário "Conteúdo GS1 do LPN": a element string do LPN é idêntica no payload usado para GS1-128 e QR', async () => {
      const device = await printerDevice();
      const job = await peripheralJobService.createLabelPrintJob({
        edgeAgentId,
        peripheralDeviceId: device.id,
        deviceCode: printerDeviceCode,
        warehouseId,
        templateCode: 'LPN_PALETE',
        fields: baseLpnFields(),
        printEntity: 'pallet',
        printEntityId: `pallet-gs1-${Date.now()}`,
        actorUserId: SEED_ACTOR_ID,
      });
      const completed = await waitForState(peripheralJobService, job.job_id, ['CONCLUIDO', 'FALHA']);
      expect(completed.state).toBe('CONCLUIDO');

      const expectedElementString = '(00)129000000000012346';
      const zpl: string = completed.payload.zpl;
      const occurrences = zpl.split(expectedElementString).length - 1;
      // Template LPN_PALETE usa ${gs1_element_string} duas vezes (QR + GS1-128) — mesmo conteúdo, duas simbologias (RN-PER-010).
      expect(occurrences).toBe(2);
    });

    it('Cenário "Job idempotente no reenvio": reenvio do mesmo job_id não reimprime — agent responde o resultado original', async () => {
      const device = await printerDevice();
      const job = await peripheralJobService.createLabelPrintJob({
        edgeAgentId,
        peripheralDeviceId: device.id,
        deviceCode: printerDeviceCode,
        warehouseId,
        templateCode: 'LPN_PALETE',
        fields: baseLpnFields(),
        printEntity: 'pallet',
        printEntityId: `pallet-idem-${Date.now()}`,
        actorUserId: SEED_ACTOR_ID,
      });
      const completed = await waitForState(peripheralJobService, job.job_id, ['CONCLUIDO', 'FALHA']);
      expect(completed.state).toBe('CONCLUIDO');
      expect(simulator.executionCountFor(job.job_id)).toBe(1);

      // Backend reenvia o MESMO envelope (simula falha de rede na resposta original) — via o registry real, mesmo transporte do gateway.
      const envelope = {
        job_id: completed.job_id,
        job_type: completed.job_type,
        device_code: completed.device_code,
        timeout_ms: completed.timeout_ms,
        payload: completed.payload,
        issued_at: new Date().toISOString(),
      };
      registry.send(edgeAgentId, 'job', envelope);
      await sleep(300);

      // Nenhuma segunda execução do handler (nenhuma "segunda etiqueta impressa").
      expect(simulator.executionCountFor(job.job_id)).toBe(1);
      const stillCompleted = await peripheralJobService.findById(job.job_id);
      expect(stillCompleted.state).toBe('CONCLUIDO');
    });

    it('Cenário "Reimpressão marcada e auditada": 2ª impressão da MESMA entidade carrega RE1 e gera audit_log PRINT', async () => {
      const device = await printerDevice();
      const printEntityId = `pallet-reprint-${Date.now()}`;

      const first = await peripheralJobService.createLabelPrintJob({
        edgeAgentId,
        peripheralDeviceId: device.id,
        deviceCode: printerDeviceCode,
        warehouseId,
        templateCode: 'LPN_PALETE',
        fields: baseLpnFields(),
        printEntity: 'pallet',
        printEntityId,
        actorUserId: SEED_ACTOR_ID,
      });
      await waitForState(peripheralJobService, first.job_id, ['CONCLUIDO', 'FALHA']);

      const reprint = await peripheralJobService.createLabelPrintJob({
        edgeAgentId,
        peripheralDeviceId: device.id,
        deviceCode: printerDeviceCode,
        warehouseId,
        templateCode: 'LPN_PALETE',
        fields: baseLpnFields(),
        printEntity: 'pallet',
        printEntityId,
        actorUserId: SEED_ACTOR_ID,
        reason: 'RF-PER-021: etiqueta danificada',
      });
      const completedReprint = await waitForState(peripheralJobService, reprint.job_id, ['CONCLUIDO', 'FALHA']);
      expect(completedReprint.state).toBe('CONCLUIDO');
      expect(completedReprint.reprint_seq).toBe(1);
      expect(completedReprint.payload.zpl).toContain('RE1');

      const audit = await db.queryGlobal(
        `SELECT * FROM wms.audit_log WHERE entity = 'peripheral_job' AND entity_id = $1 AND action = 'PRINT'`,
        [reprint.job_id]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].reason).toMatch(/RF-PER-021/);
    });

    it('Cenário "Retry assimétrico [§5.1 INVIOLÁVEL]": PRINT_ZPL falha 2x (PAPER_OUT) e tenta de novo automaticamente até CONCLUIDO (máx. 3)', async () => {
      const device = await printerDevice();
      let attempts = 0;
      simulator.setHandler(printerDeviceCode, () => {
        attempts += 1;
        if (attempts < 3) return { status: 'FALHA', error_code: 'PAPER_OUT' };
        return { status: 'CONCLUIDO', result: { printed: true } };
      });

      try {
        const job = await peripheralJobService.createLabelPrintJob({
          edgeAgentId,
          peripheralDeviceId: device.id,
          deviceCode: printerDeviceCode,
          warehouseId,
          templateCode: 'LPN_PALETE',
          fields: baseLpnFields(),
          printEntity: 'pallet',
          printEntityId: `pallet-retry-${Date.now()}`,
          actorUserId: SEED_ACTOR_ID,
        });
        const completed = await waitForState(peripheralJobService, job.job_id, ['CONCLUIDO', 'FALHA'], 8000);
        expect(completed.state).toBe('CONCLUIDO');
        expect(completed.retry_count).toBe(2);
        expect(attempts).toBe(3);
      } finally {
        simulator.clearHandler(printerDeviceCode);
      }
    });

    it('Cenário "Cancela sem retry automático [§5.1 INVIOLÁVEL]": GATE_OPEN com FALHA nunca é reenviado automaticamente', async () => {
      const device = await cancelaDevice();
      simulator.setHandler(cancelaDeviceCode, () => ({ status: 'FALHA', error_code: 'PROTOCOL_ERROR' }));

      try {
        const job = await peripheralJobService.createAndAwaitJob({
          edgeAgentId,
          peripheralDeviceId: device.id,
          deviceCode: cancelaDeviceCode,
          jobType: 'GATE_OPEN',
          warehouseId,
          payload: { acao: 'abrir' },
          actorUserId: SEED_ACTOR_ID,
        });
        expect(job.state).toBe('FALHA');
        expect(job.retry_count).toBe(0);
        expect(simulator.executionCountFor(job.job_id)).toBe(1); // nunca reenviado
      } finally {
        simulator.clearHandler(cancelaDeviceCode);
      }
    });

    it('RN-PER-020 [INVIOLÁVEL]: ativação de nova versão exige impressão de teste APROVADA (CONCLUIDO)', async () => {
      const device = await printerDevice();
      const draft = await labelTemplateService.createDraftVersion({
        code: 'ENDERECO',
        format: 'ZPL',
        widthMm: 100,
        heightMm: 50,
        content: '^XA^FO40,30^A0N,60,60^FD${location_code}^FS^FO40,110^A0N,28,28^FDZona: ${zone_code}^FS^XZ',
        requiredFields: ['location_code', 'zone_code'],
        warehouseId,
        actorUserId: SEED_ACTOR_ID,
      });
      expect(draft.status).toBe('DRAFT');
      expect(draft.version).toBeGreaterThan(1); // ENDERECO v1 já existe (seed da migration 0062)

      // Não pode ativar sem antes passar por teste aprovado.
      await expect(labelTemplateService.activate(draft.id, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'TEMPLATE_NOT_APPROVED' } });

      // Handler com atraso proposital — sem isto, o agent responde tão
      // rápido que a checagem "ainda não concluído" abaixo nunca observaria
      // um estado intermediário de verdade.
      simulator.setHandler(printerDeviceCode, async () => {
        await sleep(200);
        return { status: 'CONCLUIDO', result: { printed: true } };
      });

      const testJob = await peripheralJobService.createTestPrintJob({
        templateId: draft.id,
        fields: { location_code: 'A1-001-00-01', zone_code: 'STO' },
        edgeAgentId,
        peripheralDeviceId: device.id,
        deviceCode: printerDeviceCode,
        warehouseId,
        actorUserId: SEED_ACTOR_ID,
      });
      await labelTemplateService.markTestPrintRequested(draft.id, testJob.job_id, SEED_ACTOR_ID);
      expect((await labelTemplateService.getById(draft.id)).status).toBe('TEST_PRINT_PENDING');

      // Ainda EXECUTANDO/ENVIADO — aprovação deve rejeitar.
      await expect(labelTemplateService.approveTestPrint(draft.id, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'TEST_PRINT_NOT_COMPLETED' } });

      await waitForState(peripheralJobService, testJob.job_id, ['CONCLUIDO', 'FALHA']);
      simulator.clearHandler(printerDeviceCode);
      const approved = await labelTemplateService.approveTestPrint(draft.id, warehouseId, SEED_ACTOR_ID);
      expect(approved.status).toBe('APPROVED');

      const activated = await labelTemplateService.activate(draft.id, warehouseId, SEED_ACTOR_ID);
      expect(activated.status).toBe('ACTIVE');

      const previousActive = await db.queryGlobal(`SELECT status FROM wms.label_template WHERE code = 'ENDERECO' AND version = 1`);
      expect(previousActive.rows[0].status).toBe('RETIRED');
    });

    it('Cenário "LPR abaixo da confiança não confirma sozinho": leitura com confidence 0,72 (mínimo 0,85) marca is_suggestion_only', async () => {
      const device = await peripheralDeviceService.findByCode(lprDeviceCode);
      simulator.pushLprReading({ device_code: lprDeviceCode, plate: 'ABC1D23', confidence: 0.72, lane: 'PISTA-1', captured_at: new Date().toISOString() });
      await sleep(300);

      const reading = await db.queryGlobal(`SELECT * FROM wms.lpr_reading WHERE peripheral_device_id = $1 AND plate = 'ABC1D23' ORDER BY created_at DESC LIMIT 1`, [device.id]);
      expect(reading.rows).toHaveLength(1);
      expect(Number(reading.rows[0].confidence)).toBeCloseTo(0.72, 2);

      // RNF-PER-060: is_suggestion_only não é persistido na tabela (é derivado no momento da leitura) — recalcula via LprService com a mesma leitura para confirmar a regra.
      const direct = await lprService.receiveReading({
        warehouseId,
        peripheralDeviceId: device.id,
        plate: 'ABC1D23',
        confidence: 0.72,
        lane: 'PISTA-1',
        capturedAt: new Date().toISOString(),
      });
      expect(direct.is_suggestion_only).toBe(true);

      const aboveThreshold = await lprService.receiveReading({
        warehouseId,
        peripheralDeviceId: device.id,
        plate: 'XYZ9A88',
        confidence: 0.97,
        lane: 'PISTA-1',
        capturedAt: new Date().toISOString(),
      });
      expect(aboveThreshold.is_suggestion_only).toBe(false);
    });
  });

  describe('Desconectado (agent OFFLINE — fila de impressão, RF-PER-021)', () => {
    beforeAll(async () => {
      // handleDisconnect() do gateway roda assíncrono a partir do close do
      // socket (client.disconnect() não espera o servidor terminar) — evita
      // corrida com os testes abaixo, que dependem de registry.isOnline()
      // já estar false.
      const deadline = Date.now() + 3000;
      while (registry.isOnline(edgeAgentId) && Date.now() < deadline) {
        await sleep(50);
      }
      expect(registry.isOnline(edgeAgentId)).toBe(false);
    });

    it('3 jobs de impressão ficam PENDENTE em ordem; ao reconectar o agent, são executados na ordem de criação', async () => {
      const device = await printerDevice();
      const jobs = [];
      for (let i = 0; i < 3; i++) {
        const job = await peripheralJobService.createLabelPrintJob({
          edgeAgentId,
          peripheralDeviceId: device.id,
          deviceCode: printerDeviceCode,
          warehouseId,
          templateCode: 'LPN_PALETE',
          fields: baseLpnFields(),
          printEntity: 'pallet',
          printEntityId: `pallet-queue-${i}-${Date.now()}`,
          actorUserId: SEED_ACTOR_ID,
        });
        jobs.push(job);
        await sleep(10); // created_at estritamente crescente
      }
      for (const job of jobs) {
        expect((await peripheralJobService.findById(job.job_id)).state).toBe('PENDENTE');
      }

      const simulator = new EdgeAgentSimulator({ backendUrl: wsUrl, token: deviceToken, heartbeatIntervalMs: 60000, telemetryIntervalMs: 60000 });
      try {
        await simulator.connect(); // handleConnection() chama dispatchPendingForAgent() — RF-PER-021
        await sleep(500);

        for (const job of jobs) {
          const completed = await waitForState(peripheralJobService, job.job_id, ['CONCLUIDO', 'FALHA']);
          expect(completed.state).toBe('CONCLUIDO');
        }
        // Ordem de execução no agent == ordem de criação (RF-PER-021).
        const executedOrder = jobs.map((j) => simulator.receivedJobs.findIndex((r) => r.job_id === j.job_id));
        expect(executedOrder).toEqual([...executedOrder].sort((a, b) => a - b));
      } finally {
        await simulator.disconnect();
      }
    });

    it('job PRINT_ZPL além da validade da fila (30 min) expira com alerta (perifericos.job_falha)', async () => {
      const device = await printerDevice();
      const job = await peripheralJobService.createLabelPrintJob({
        edgeAgentId,
        peripheralDeviceId: device.id,
        deviceCode: printerDeviceCode,
        warehouseId,
        templateCode: 'LPN_PALETE',
        fields: baseLpnFields(),
        printEntity: 'pallet',
        printEntityId: `pallet-expire-${Date.now()}`,
        actorUserId: SEED_ACTOR_ID,
      });
      expect((await peripheralJobService.findById(job.job_id)).state).toBe('PENDENTE');

      // Simula 31 minutos decorridos (RF-PER-021: validade de 30 min).
      await db.queryGlobal(`UPDATE wms.peripheral_job SET expires_at = now() - INTERVAL '1 minute' WHERE job_id = $1`, [job.job_id]);

      await peripheralJobService.sweepExpiredJobs();
      const expired = await peripheralJobService.findById(job.job_id);
      expect(expired.state).toBe('EXPIRADO');

      const alertEvent = await db.queryGlobal(
        `SELECT * FROM wms.event_outbox WHERE event_type = 'perifericos.job_falha' AND payload->>'job_id' = $1`,
        [job.job_id]
      );
      expect(alertEvent.rows).toHaveLength(1);
    });
  });
});
