// RNF-ARQ-070: Structured logging with trace_id and span_id
import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import pino from 'pino';
import { v4 as uuid } from 'uuid';

interface LogContext {
  trace_id?: string;
  span_id?: string;
  user_id?: string;
  tenant_id?: string;
  warehouse_id?: string;
  device?: string;
  [key: string]: unknown;
}

@Injectable()
export class LoggerService implements NestLoggerService {
  private logger: pino.Logger;
  private context: LogContext = {};

  constructor() {
    const isDevelopment = process.env.NODE_ENV === 'development';

    this.logger = pino(
      isDevelopment
        ? {
            level: process.env.LOG_LEVEL || 'info',
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: false,
              },
            },
          }
        : {
            level: process.env.LOG_LEVEL || 'info',
          }
    );
  }

  setContext(context: LogContext): void {
    this.context = {
      ...this.context,
      ...context,
    };
  }

  log(message: string, context?: LogContext): void {
    this.logger.info({ ...this.context, ...context }, message);
  }

  error(message: string, trace?: unknown, context?: LogContext): void {
    const errorContext = {
      ...this.context,
      ...context,
      trace_id: this.context.trace_id || uuid(),
      span_id: this.context.span_id || uuid(),
      error: trace,
    };
    this.logger.error(errorContext, message);
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn({ ...this.context, ...context }, message);
  }

  debug(message: string, context?: LogContext): void {
    this.logger.debug({ ...this.context, ...context }, message);
  }

  verbose(message: string, context?: LogContext): void {
    this.logger.trace({ ...this.context, ...context }, message);
  }
}
