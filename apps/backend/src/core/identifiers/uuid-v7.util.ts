// DOC-00 RG-011 — "Chaves primárias: UUID v7".
//
// Fonte ÚNICA de geração de identificador no backend. O padrão do projeto é
// deixar o banco gerar a PK (DEFAULT wms.uuid_v7(), migration 0077); esta
// função existe para os poucos casos em que a aplicação precisa conhecer o
// ID ANTES do INSERT (ex.: montar filhos que referenciam o pai na mesma
// transação, ou devolver o ID ao chamador antes de gravar).
//
// É PROIBIDO voltar a usar `v4 as uuid` do pacote `uuid` para gerar
// identificador de entidade: v4 é aleatório e destrói a localidade de
// escrita do índice de PK, que é justamente o que a RG-011 evita.
// (`uuid.v4()` segue legítimo para o que NÃO é chave de entidade — trace
// id de log, sufixo de nome de arquivo, etc.)
import { randomBytes } from 'node:crypto';

/**
 * UUID v7 conforme RFC 9562 §5.7 — mesma composição da função SQL
 * `wms.uuid_v7()`:
 *   48 bits de timestamp (ms) | ver(4)=0111 | rand_a(12) | var(2)=10 | rand_b(62)
 */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());

  // bytes 0..5 — timestamp big-endian (prefixo que dá a ordenação temporal)
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // versão 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC (10xx)

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
