// RNF-ARQ-010..013: PostgreSQL connection module with RLS enforcement
// ADR-001-RESOLVED: node-pg for connection + RLS context
import { Module, OnModuleInit, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from './database.service';
import { MigrationRunner } from './migration.runner';
import { Pool } from 'pg';

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);
  private migrationRunner: MigrationRunner;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService
  ) {}

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

    // Run pending migrations on startup
    const port = getConfigValue('POSTGRES_PORT', '5432');
    const portNum = typeof port === 'string' ? parseInt(port, 10) : port;

    const pool = new Pool({
      host: getConfigValue('POSTGRES_HOST', 'localhost'),
      port: portNum,
      database: getConfigValue('POSTGRES_DB', 'wms_db'),
      user: getConfigValue('POSTGRES_USER', 'postgres'),
      password: getConfigValue('POSTGRES_PASSWORD', 'postgres_root_password'),
      max: 5,
    });

    try {
      this.migrationRunner = new MigrationRunner(pool);
      const count = await this.migrationRunner.runPending();
      this.logger.log(`✓ Ran ${count} pending migrations`);
    } catch (error) {
      this.logger.error('Failed to run migrations', error);
      throw error;
    } finally {
      await pool.end();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.databaseService) {
      await this.databaseService.close();
    }
  }
}
