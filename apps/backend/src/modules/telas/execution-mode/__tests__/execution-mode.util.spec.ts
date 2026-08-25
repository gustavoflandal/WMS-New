// DOC-17 RN-TEL-010 [INVIOLÁVEL] — Modo de Execução.
import { describe, it, expect } from 'vitest';
import { isChannelAllowed, isSameChannelContinuation, parseExecutionMode } from '../execution-mode.util.js';

describe('isChannelAllowed (RN-TEL-010)', () => {
  it('COLETOR: só dispositivos — tela e formulário barrados', () => {
    expect(isChannelAllowed('COLETOR', 'COLETOR')).toBe(true);
    expect(isChannelAllowed('COLETOR', 'TELA')).toBe(false);
    expect(isChannelAllowed('COLETOR', 'FORMULARIO')).toBe(false);
  });

  it('TELA: "apenas telas E FORMULÁRIOS" — coletor barrado', () => {
    expect(isChannelAllowed('TELA', 'TELA')).toBe(true);
    expect(isChannelAllowed('TELA', 'FORMULARIO')).toBe(true);
    expect(isChannelAllowed('TELA', 'COLETOR')).toBe(false);
  });

  it('HIBRIDO: ambos, à escolha do operador', () => {
    expect(isChannelAllowed('HIBRIDO', 'COLETOR')).toBe(true);
    expect(isChannelAllowed('HIBRIDO', 'TELA')).toBe(true);
    expect(isChannelAllowed('HIBRIDO', 'FORMULARIO')).toBe(true);
  });
});

describe('isSameChannelContinuation (RN-TEL-010, trava de dupla contagem)', () => {
  it('tarefa ainda não iniciada aceita qualquer canal', () => {
    expect(isSameChannelContinuation(null, 'COLETOR')).toBe(true);
    expect(isSameChannelContinuation(null, 'TELA')).toBe(true);
  });

  it('tarefa iniciada no coletor NÃO pode ser concluída por tela', () => {
    expect(isSameChannelContinuation('COLETOR', 'TELA')).toBe(false);
  });

  it('tarefa iniciada por tela NÃO pode ser concluída no coletor', () => {
    expect(isSameChannelContinuation('TELA', 'COLETOR')).toBe(false);
  });

  it('tela e formulário são canais DISTINTOS entre si para efeito da trava', () => {
    // Ambos passam por `isChannelAllowed` no modo TELA, mas continuar no
    // outro ainda seria dois registros do mesmo trabalho.
    expect(isSameChannelContinuation('TELA', 'FORMULARIO')).toBe(false);
    expect(isSameChannelContinuation('FORMULARIO', 'TELA')).toBe(false);
  });

  it('continuar no mesmo canal é sempre permitido', () => {
    expect(isSameChannelContinuation('COLETOR', 'COLETOR')).toBe(true);
    expect(isSameChannelContinuation('TELA', 'TELA')).toBe(true);
    expect(isSameChannelContinuation('FORMULARIO', 'FORMULARIO')).toBe(true);
  });
});

describe('parseExecutionMode', () => {
  it('aceita os três valores do catálogo', () => {
    expect(parseExecutionMode('COLETOR')).toBe('COLETOR');
    expect(parseExecutionMode('TELA')).toBe('TELA');
    expect(parseExecutionMode('HIBRIDO')).toBe('HIBRIDO');
  });

  it('parâmetro ausente ou corrompido NÃO libera canal novo — cai em COLETOR', () => {
    expect(parseExecutionMode(null)).toBe('COLETOR');
    expect(parseExecutionMode('')).toBe('COLETOR');
    expect(parseExecutionMode('QUALQUER_COISA')).toBe('COLETOR');
    expect(parseExecutionMode('hibrido')).toBe('COLETOR'); // case-sensitive de propósito
  });
});
