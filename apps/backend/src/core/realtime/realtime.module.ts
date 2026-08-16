// RF-ARQ-040..043: Real-time module (Socket.IO gateway)
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeAuthorizationProvider } from './realtime-authorization.provider.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { JwtModule } from '../auth/jwt.module.js';

@Module({
  imports: [ConfigModule, RbacModule, JwtModule],
  providers: [
    RealtimeGateway,
    RealtimeAuthorizationProvider,
    {
      // DOC-12: substitui o provider de desenvolvimento (era `useValue: null`).
      provide: 'AUTHORIZATION_PROVIDER',
      useExisting: RealtimeAuthorizationProvider,
    },
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
