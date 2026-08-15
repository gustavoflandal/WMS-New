// RNF-ARQ-072: GET /metrics — Prometheus exposition format (exempt from rate limiting)
import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async getMetrics(@Res() res: Response): Promise<void> {
    const { contentType, body } = await this.metricsService.render();
    res.set('Content-Type', contentType);
    res.send(body);
  }
}
