// @vitest-environment jsdom
// DOC-15 RNF-COL-010 [INVIOLÁVEL] — leitor físico funciona sem depender de
// campo focado: o listener é global em `document`, nunca preso a um <input>.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWedgeScanner } from '../use-wedge-scanner.js';

function fireKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

function fireCode(code: string): void {
  for (const ch of code) fireKey(ch);
  fireKey('Enter');
}

describe('DOC-15 RNF-COL-010 — leitura wedge sem campo focado', () => {
  it('captura um código disparado no document, sem nenhum elemento focado', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScanner(onScan));

    expect(document.activeElement).toBe(document.body);
    fireCode('7891000100103');

    expect(onScan).toHaveBeenCalledWith('7891000100103');
  });

  it('não dispara para buffer vazio (Enter isolado)', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScanner(onScan));

    fireKey('Enter');

    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignora teclas de modificador/navegação (comprimento de key > 1)', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScanner(onScan));

    fireKey('Shift');
    fireKey('ArrowLeft');
    fireCode('123');

    expect(onScan).toHaveBeenCalledWith('123');
  });

  it('não registra o listener quando enabled=false (ex.: câmera ativa)', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScanner(onScan, false));

    fireCode('999');

    expect(onScan).not.toHaveBeenCalled();
  });

  it('remove o listener ao desmontar', () => {
    const onScan = vi.fn();
    const { unmount } = renderHook(() => useWedgeScanner(onScan));
    unmount();

    fireCode('123');

    expect(onScan).not.toHaveBeenCalled();
  });
});
