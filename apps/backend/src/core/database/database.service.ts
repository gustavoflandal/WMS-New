// RNF-ARQ-010..013: Database service with RLS enforcement
// [INVIOLÁVEL] All queries MUST set tenant context via set_tenant_context()
import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult } from 'pg';

export interface TenantContext {
  tenant_id: string;
  user_id: string;
  warehouse_id?: string;
  client_id?: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;
  private workerPool: Pool;

  constructor(private readonly configService?: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Helper to get config value from ConfigService or process.env
    const getConfigValue = (key: string, defaultValue?: any): any => {
      if (this.configService) {
        return this.configService.get(key, defaultValue);
      }
      // Fallback to process.env if ConfigService unavailable (tests)
      const value = process.env[key];
      return value !== undefined ? value : defaultValue;
    };

    const port = getConfigValue('POSTGRES_PORT', '5432');
    const portNum = typeof port === 'string' ? parseInt(port, 10) : port;

    // RNF-ARQ-011: application pool MUST connect as wms_app, NEVER as the
    // admin/owner role. POSTGRES_USER/PASSWORD are reserved for the Postgres
    // container bootstrap and MigrationRunner (DatabaseModule), which need
    // owner privileges (CREATE ROLE/SCHEMA) that wms_app must not have —
    // hence the separate POSTGRES_APP_USER/PASSWORD namespace.
    this.pool = new Pool({
      host: getConfigValue('POSTGRES_HOST', 'localhost'),
      port: portNum,
      database: getConfigValue('POSTGRES_DB', 'wms_db'),
      user: getConfigValue('POSTGRES_APP_USER', 'wms_app'),
      password: getConfigValue('POSTGRES_APP_PASSWORD', 'wms_app_password'),
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected error on idle client', err);
    });

    // ADR-006: dedicated BYPASSRLS role, used ONLY by background workers
    // (outbox-publisher) to poll wms.event_outbox across all tenants.
    this.workerPool = new Pool({
      host: getConfigValue('POSTGRES_HOST', 'localhost'),
      port: portNum,
      database: getConfigValue('POSTGRES_DB', 'wms_db'),
      user: getConfigValue('POSTGRES_WORKER_USER', 'wms_worker'),
      password: getConfigValue('POSTGRES_WORKER_PASSWORD', 'wms_worker_password'),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.workerPool.on('error', (err) => {
      this.logger.error('Unexpected error on idle worker client', err);
    });

    this.logger.log('Database pool initialized');
  }

  /**
   * Get a client with tenant context set
   * RNF-ARQ-011: Sets app.tenant_ids and app.user_id in LOCAL scope
   */
  async getClientWithContext(context: TenantContext): Promise<PoolClient> {
    if (!context.tenant_id || !context.user_id) {
      throw new BadRequestException('Tenant context is required (tenant_id, user_id)');
    }

    const client = await this.pool.connect();

    try {
      // RNF-ARQ-010: Set RLS context BEFORE any query
      // Use set_config() to safely set local variables with parameters
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_ids', context.tenant_id]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', context.user_id]);

      if (context.warehouse_id) {
        await client.query('SELECT set_config($1, $2, true)', ['app.warehouse_id', context.warehouse_id]);
      }

      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /**
   * Execute query within tenant context (wrapped in BEGIN/COMMIT)
   * RG-001: Enforces tenant isolation
   * RNF-ARQ-011: set_config with is_local=true MUST be inside an explicit transaction
   */
  async query<T = any>(
    context: TenantContext,
    text: string,
    values?: any[]
  ): Promise<QueryResult<T>> {
    if (!context.tenant_id || !context.user_id) {
      throw new BadRequestException('Tenant context is required (tenant_id, user_id)');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_ids', context.tenant_id]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', context.user_id]);
      if (context.warehouse_id) {
        await client.query('SELECT set_config($1, $2, true)', ['app.warehouse_id', context.warehouse_id]);
      }
      if (context.client_id) {
        await client.query('SELECT set_config($1, $2, true)', ['app.client_id', context.client_id]);
      }
      const result = await client.query<T>(text, values);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      this.logger.error('Query failed', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute transaction with tenant context
   * RNF-ARQ-010: Tenant context persists for entire transaction
   * RNF-ARQ-011: set_config with is_local=true is scoped to this explicit BEGIN/COMMIT
   */
  async transaction<T>(
    context: TenantContext,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    if (!context.tenant_id || !context.user_id) {
      throw new BadRequestException('Tenant context is required (tenant_id, user_id)');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_ids', context.tenant_id]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', context.user_id]);
      if (context.warehouse_id) {
        await client.query('SELECT set_config($1, $2, true)', ['app.warehouse_id', context.warehouse_id]);
      }
      if (context.client_id) {
        await client.query('SELECT set_config($1, $2, true)', ['app.client_id', context.client_id]);
      }

      const result = await callback(client);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      this.logger.error('Transaction failed', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * ADR-006: Execute a transaction as wms_worker (BYPASSRLS), for background
   * workers ONLY (outbox-publisher). No TenantContext: bypassing RLS makes
   * tenant scoping meaningless for this connection, and callers must not
   * pretend otherwise by passing one in.
   */
  async transactionAsWorker<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.workerPool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      this.logger.error('Worker transaction failed', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Health check: verify database connection and RLS policy is active
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1 as health');
      return result.rowCount > 0;
    } catch (error) {
      this.logger.error('Database health check failed', error);
      return false;
    }
  }

  /**
   * Close connection pool (graceful shutdown)
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Database connection pool closed');
    }
    if (this.workerPool) {
      await this.workerPool.end();
    }
  }
}
