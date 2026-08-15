// RF-ARQ-040..043: Real-time module (Socket.IO gateway)
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway.js';

@Module({
  imports: [ConfigModule],
  providers: [
    RealtimeGateway,
    {
      provide: 'AUTHORIZATION_PROVIDER',
      useValue: null, // [LACUNA: Real auth provider from DOC-12]
    },
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
