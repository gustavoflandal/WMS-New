// RNF-ARQ-072: Prometheus metrics registry.
// outbox_lag_seconds / outbox_pending_total are computed by the outbox-publisher
// worker (a SEPARATE process, RNF-ARQ-003) and pushed to Redis; this service
// reads them back on every scrape via a Gauge `collect()` callback.
import { Injectable } from '@nestjs/common';
import { Registry, Gauge, collectDefaultMetrics } from 'prom-client';
import { CacheService } from '../cache/cache.service.js';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  constructor(private readonly cacheService: CacheService) {
    collectDefaultMetrics({ register: this.registry });

    const cache = this.cacheService;

    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age in seconds of the oldest unpublished wms.event_outbox row (RNF-ARQ-031/072)',
      registers: [this.registry],
      async collect() {
        const raw = await cache.getRaw('wms:metrics:outbox_lag_seconds').catch(() => null);
        this.set(raw ? parseFloat(raw) : 0);
      },
    });

    new Gauge({
      name: 'outbox_pending_total',
      help: 'Count of unpublished rows in wms.event_outbox (RNF-ARQ-031/072)',
      registers: [this.registry],
      async collect() {
        const raw = await cache.getRaw('wms:metrics:outbox_pending_total').catch(() => null);
        this.set(raw ? parseFloat(raw) : 0);
      },
    });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
