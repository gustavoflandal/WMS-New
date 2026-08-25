// DOC-08 RNF-FIS-063 / DOC-01 RNF-ARQ-100 — primeiro utilitário genérico de
// cifragem em repouso do projeto (nenhum existia antes desta sessão, ver
// achado da exploração da Sessão 8B). AES-256-GCM com Node `crypto` nativo
// (sem dependência nova), chave via variável de ambiente/secret manager
// (RNF-ARQ-100: "segredos exclusivamente por variáveis de ambiente/secret
// manager") — sem KMS neste ambiente, a chave É o segredo de ambiente.
//
// Uso inicial: certificado A1 (PFX) + senha do certificado, armazenados em
// `wms.fiscal_issuer`. Reutilizável por qualquer módulo futuro que precise
// cifrar um segredo em coluna de banco.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export interface CipherResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recomendado para GCM
const KEY_LENGTH = 32; // 256 bits

@Injectable()
export class SecretCipherService {
  private readonly logger = new Logger(SecretCipherService.name);
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    // RNF-ARQ-100: segredo exclusivamente por variável de ambiente. Sem
    // fallback silencioso (fail-fast, CLAUDE.md §3) — configuração ausente
    // derruba o boot, nunca cifra com uma chave adivinhada.
    const raw = this.configService.get<string>('SECRET_ENCRYPTION_KEY');
    if (!raw) {
      throw new Error('SECRET_ENCRYPTION_KEY não configurada — obrigatória para cifrar certificados fiscais (RNF-ARQ-100)');
    }
    // A variável pode ser a chave já em hex/base64 (32 bytes) ou uma
    // passphrase livre — deriva sempre via scrypt para chegar a 32 bytes
    // determinísticos, com um salt fixo por variável de ambiente dedicada
    // (documentado: não é o segredo em si, só evita colisão trivial).
    const salt = this.configService.get<string>('SECRET_ENCRYPTION_SALT', 'wms-fiscal-issuer-v1');
    this.key = scryptSync(raw, salt, KEY_LENGTH);
  }

  encrypt(plaintext: Buffer): CipherResult {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, iv, authTag };
  }

  decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): Buffer {
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    // Nunca logar o resultado — certificado/senha decifrados só em memória,
    // pelo tempo estritamente necessário da assinatura (RNF-FIS-060).
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
