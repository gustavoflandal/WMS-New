// DOC-11 RNF-PER-060 — recepção e normalização de leituras LPR. O Edge
// Agent empurra a leitura (push HTTP local à câmera OU polling — decisão
// do driver, transparente ao backend); aqui só entra a leitura já
// normalizada `{ plate, confidence, lane, captured_at, image_ref }`.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';

export interface ReceiveLprReadingInput {
  warehouseId: string;
  peripheralDeviceId: string;
  plate: string;
  confidence: number;
  lane?: string | null;
  capturedAt: string;
  imageRef?: string | null;
}

@Injectable()
export class LprService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  /**
   * RNF-PER-060: registra a leitura e publica no tópico da portaria. Não
   * decide "confirmação automática" aqui — RF-POR-010 (fora desta camada)
   * é quem consome `is_suggestion_only` para renderizar como sugestão
   * editável ou não. A leitura NUNCA vincula sozinha a uma visita.
   */
  async receiveReading(input: ReceiveLprReadingInput) {
    const minConfidence = await this.getMinConfidence();
    const isSuggestionOnly = input.confidence < minConfidence;

    const result = await this.db.transactionAsWorker(async (client) => {
      const inserted = await client.query(
        `INSERT INTO wms.lpr_reading (warehouse_id, peripheral_device_id, plate, confidence, lane, captured_at, image_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.warehouseId, input.peripheralDeviceId, input.plate, input.confidence, input.lane ?? null, input.capturedAt, input.imageRef ?? null]
      );
      const reading = inserted.rows[0];

      await this.eventsService.publishInTransaction(client, {
        event_type: 'perifericos.placa_lida',
        tenant_id: null,
        warehouse_id: input.warehouseId,
        payload: { lpr_reading_id: reading.id, plate: reading.plate, confidence: Number(reading.confidence), lane: reading.lane, is_suggestion_only: isSuggestionOnly },
      });

      return reading;
    });

    return { ...result, is_suggestion_only: isSuggestionOnly };
  }

  /** RF-POR-010: última leitura não vinculada de uma pista — candidata a sugestão no gate-in. */
  async getLatestUnlinkedReading(warehouseId: string, lane: string) {
    const result = await this.db.queryGlobal(
      `SELECT * FROM wms.lpr_reading WHERE warehouse_id = $1 AND lane = $2 AND vehicle_visit_id IS NULL ORDER BY captured_at DESC LIMIT 1`,
      [warehouseId, lane]
    );
    return result.rows[0] ?? null;
  }

  /** Vincula a leitura à visita resultante do gate-in (chamado por GateInService quando `lpr_reading_id` é informado). */
  async linkToVehicleVisit(lprReadingId: string, vehicleVisitId: string): Promise<void> {
    await this.db.queryGlobal(`UPDATE wms.lpr_reading SET vehicle_visit_id = $2 WHERE id = $1`, [lprReadingId, vehicleVisitId]);
  }

  private async getMinConfidence(): Promise<number> {
    const result = await this.db.queryGlobal(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'PER.LPR_CONFIANCA_MIN'`);
    return Number(result.rows[0]?.value ?? 0.85);
  }
}
