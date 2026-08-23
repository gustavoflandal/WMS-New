// RNF-ARQ-072: GET /metrics — Prometheus exposition format (exempt from rate limiting)
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';
import { Public } from '../rbac/decorators/public.decorator.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  // Endpoint de scraping do Prometheus — sem JWT de usuário (infra interna),
  // mesma decisão operacional de /health. [LACUNA: DOC-12 não trata
  // explicitamente autenticação de endpoints de infraestrutura/scraping.]
  @Public()
  @Get()
  async getMetrics(@Res() res: Response): Promise<void> {
    const { contentType, body } = await this.metricsService.render();
    res.set('Content-Type', contentType);
    res.send(body);
  }
}
