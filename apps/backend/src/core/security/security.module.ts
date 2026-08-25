import { Module } from '@nestjs/common';
import { SecretCipherService } from './secret-cipher.service.js';

@Module({
  providers: [SecretCipherService],
  exports: [SecretCipherService],
})
export class SecurityModule {}
