// DOC-15 RNF-COL-010 [INVIOLÁVEL] — leitor físico EXCLUSIVAMENTE em modo
// teclado (wedge): listener global de teclado, SEM depender de campo
// focado — a leitura vale na tela inteira da tarefa. Detecção por
// velocidade de digitação (um wedge "digita" um código de 18 dígitos em
// poucos ms; uma pessoa não) + terminador configurável
// (COL.SCAN_TERMINADOR — Enter por padrão).
'use client';

import { useEffect, useRef } from 'react';

const MAX_INTER_KEY_GAP_MS = 50;
const TERMINATOR_KEYS = new Set(['Enter', 'Tab']);

export function useWedgeScanner(onScan: (code: string) => void, enabled = true): void {
  const bufferRef = useRef('');
  const lastKeyAtRef = useRef(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent): void {
      const now = performance.now();
      const gap = now - lastKeyAtRef.current;
      lastKeyAtRef.current = now;

      if (TERMINATOR_KEYS.has(event.key)) {
        if (bufferRef.current.length > 0) {
          onScanRef.current(bufferRef.current);
        }
        bufferRef.current = '';
        return;
      }

      // Tecla imprimível de 1 caractere só (ignora modificadores/setas/etc).
      if (event.key.length !== 1) return;

      // Gap grande = não é um wedge disparando em sequência — reinicia o
      // buffer como se fosse o início de uma nova leitura (protege contra
      // digitação humana lenta sendo tratada como scan).
      if (gap > MAX_INTER_KEY_GAP_MS && bufferRef.current.length > 0) {
        bufferRef.current = '';
      }

      bufferRef.current += event.key;
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}
