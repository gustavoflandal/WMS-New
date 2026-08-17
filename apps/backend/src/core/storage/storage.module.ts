import { Module } from '@nestjs/common';
import { FileStorageService } from './file-storage.service.js';

@Module({
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class StorageModule {}
