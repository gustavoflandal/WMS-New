// Helpers compartilhados pelos testes de integração de cadastro (DOC-02).
import { v4 as uuid } from 'uuid';

const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

/** Gera um CNPJ com dígito verificador válido (mesmo algoritmo de wms.is_valid_cnpj), único a cada chamada. */
export function generateValidCnpj(): string {
  let base: number[];
  do {
    base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  } while (base.every((d) => d === base[0]));
  const dv1 = checkDigit(base, CNPJ_WEIGHTS_1);
  const dv2 = checkDigit([...base, dv1], CNPJ_WEIGHTS_2);
  return [...base, dv1, dv2].join('');
}

/** Código curto único (formato ^[A-Z0-9]{1,6}$) para warehouse.code em testes isolados. */
export function randomWarehouseCode(): string {
  return 'T' + uuid().replace(/-/g, '').substring(0, 5).toUpperCase();
}

export const SEED_ACTOR_ID = uuid();
