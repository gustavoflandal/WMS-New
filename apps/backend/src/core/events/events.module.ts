// RNF-ARQ-030..033: Events module (outbox pattern)
import { Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { DatabaseModule } from '../database/database.module.js';

@Module({
  imports: [DatabaseModule],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
