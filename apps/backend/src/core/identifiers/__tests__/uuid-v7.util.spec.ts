// DOC-00 RG-011 — trava a conformidade do gerador de PK.
//
// Existe porque a implementação anterior (infra/postgres/init/02-extensions.sql,
// nunca usada) parecia v7 mas NÃO gravava os nibbles de versão nem os bits de
// variante: gerava um UUID que ordenava por tempo e mentia sobre a própria
// versão. Nada no projeto teria detectado isso.
import { describe, it, expect } from 'vitest';
import { uuidV7 } from '../uuid-v7.util.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuidV7 (RG-011)', () => {
  it('tem o formato canônico de UUID', () => {
    expect(uuidV7()).toMatch(UUID_RE);
  });

  it('declara versão 7 (primeiro dígito do 3º grupo)', () => {
    for (let i = 0; i < 200; i++) {
      expect(uuidV7().split('-')[2][0]).toBe('7');
    }
  });

  it('declara a variante RFC 4122/9562 (10xx — primeiro dígito do 4º grupo em 8/9/a/b)', () => {
    for (let i = 0; i < 200; i++) {
      expect(['8', '9', 'a', 'b']).toContain(uuidV7().split('-')[3][0]);
    }
  });

  it('é ordenável por tempo: o prefixo de 48 bits cresce com o relógio', async () => {
    const before = uuidV7();
    await new Promise((r) => setTimeout(r, 5));
    const after = uuidV7();
    const prefix = (u: string) => u.slice(0, 8) + u.slice(9, 13);
    expect(prefix(after) > prefix(before)).toBe(true);
  });

  it('o prefixo temporal corresponde ao Date.now() do momento da geração', () => {
    const t0 = Date.now();
    const u = uuidV7();
    const t1 = Date.now();
    const tsFromUuid = parseInt(u.slice(0, 8) + u.slice(9, 13), 16);
    expect(tsFromUuid).toBeGreaterThanOrEqual(t0);
    expect(tsFromUuid).toBeLessThanOrEqual(t1);
  });

  it('não colide dentro do mesmo milissegundo (62 bits aleatórios)', () => {
    const generated = new Set<string>();
    for (let i = 0; i < 10_000; i++) generated.add(uuidV7());
    expect(generated.size).toBe(10_000);
  });
});
