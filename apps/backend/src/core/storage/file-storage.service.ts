// DOC-04 RN-REC-022 [INVIOLÁVEL] — fotos de AVARIA armazenadas no S3.
// Primeira implementação real de armazenamento de objetos no backend
// (MinIO, já provisionado no docker-compose desde a Sessão 1.5 mas sem
// nenhum client até agora). Cliente mínimo: upload de bytes + geração de
// chave, nada de URLs pré-assinadas/multipart — RG-008/DOC-11 (periféricos)
// não se aplica aqui (upload de foto de conferente via navegador é uma
// operação HTTP normal, não acesso direto a hardware).
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { v4 as uuid } from 'uuid';

@Injectable()
export class FileStorageService implements OnModuleInit {
  private readonly logger = new Logger(FileStorageService.name);
  private client!: MinioClient;
  private bucket!: string;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const endpoint = this.configService.get<string>('MINIO_ENDPOINT', 'http://localhost:9000');
    const url = new URL(endpoint);
    this.bucket = this.configService.get<string>('MINIO_BUCKET_NAME', 'wms');

    this.client = new MinioClient({
      endPoint: url.hostname,
      port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
      useSSL: url.protocol === 'https:',
      accessKey: this.configService.get<string>('MINIO_ACCESS_KEY', 'minioadmin'),
      secretKey: this.configService.get<string>('MINIO_SECRET_KEY', 'minioadmin'),
    });
  }

  /**
   * Envia um objeto (foto de avaria, RN-REC-022) e retorna a chave gerada.
   * Chave prefixada por entidade/entityId para organização (não exigida
   * pelo DOC-04, mas evita colisão e facilita auditoria manual do bucket).
   */
  async upload(entity: string, entityId: string, fileName: string, contentType: string, data: Buffer): Promise<string> {
    const key = `${entity}/${entityId}/${uuid()}-${fileName}`;
    await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': contentType });
    this.logger.debug(`Uploaded ${key} (${data.length} bytes) to bucket ${this.bucket}`);
    return key;
  }

  /** Confere que um objeto existe (usado por testes e validações). */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  async getSize(key: string): Promise<number> {
    const stat = await this.client.statObject(this.bucket, key);
    return stat.size;
  }

  /** DOC-08 RF-FIS-064/RNF-FIS-063 — recupera XML/DANFE já gravados (reimpressão, evento). */
  async download(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}
