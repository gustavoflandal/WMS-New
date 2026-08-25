import { describe, expect, it } from 'vitest';
import {
  LessRestrictiveDispositionOverrideError,
  ReintegrationOfExpiredItemDeniedError,
  suggestDisposition,
  validateDispositionOverride,
} from '../disposition-matrix.util.js';

describe('DOC-07 RN-REV-021 — matriz de destinação', () => {
  describe('suggestDisposition', () => {
    it('íntegro dentro do shelf life mínimo sugere REINTEGRAR', () => {
      expect(suggestDisposition({ physicalState: 'INTEGRO', meetsMinimumShelfLife: true, isMedicamento: false })).toBe('REINTEGRAR');
    });

    it('íntegro abaixo do shelf life mínimo (não vencido) sugere QUARENTENA', () => {
      expect(suggestDisposition({ physicalState: 'INTEGRO', meetsMinimumShelfLife: false, isMedicamento: false })).toBe('QUARENTENA');
    });

    it('embalagem violada sugere QUARENTENA independente da validade', () => {
      expect(suggestDisposition({ physicalState: 'EMBALAGEM_VIOLADA', meetsMinimumShelfLife: true, isMedicamento: false })).toBe('QUARENTENA');
      expect(suggestDisposition({ physicalState: 'EMBALAGEM_VIOLADA', meetsMinimumShelfLife: false, isMedicamento: false })).toBe('QUARENTENA');
    });

    it('danificado sugere AVARIA independente da validade', () => {
      expect(suggestDisposition({ physicalState: 'DANIFICADO', meetsMinimumShelfLife: true, isMedicamento: false })).toBe('AVARIA');
    });

    it('vencido sugere DESCARTE', () => {
      expect(suggestDisposition({ physicalState: 'VENCIDO', meetsMinimumShelfLife: false, isMedicamento: false })).toBe('DESCARTE');
    });

    it('MEDICAMENTO íntegro e dentro do shelf life sugere QUARENTENA, nunca REINTEGRAR direto (cenário Gherkin DOC-07 §6)', () => {
      expect(suggestDisposition({ physicalState: 'INTEGRO', meetsMinimumShelfLife: true, isMedicamento: true })).toBe('QUARENTENA');
    });
  });

  describe('validateDispositionOverride', () => {
    it('permite confirmar exatamente a sugestão', () => {
      expect(() =>
        validateDispositionOverride({ suggested: 'REINTEGRAR', confirmed: 'REINTEGRAR', physicalState: 'INTEGRO', suggestionMetShelfLife: true })
      ).not.toThrow();
    });

    it('permite override para destinação MAIS restritiva sem decisão do cliente', () => {
      expect(() =>
        validateDispositionOverride({ suggested: 'REINTEGRAR', confirmed: 'QUARENTENA', physicalState: 'INTEGRO', suggestionMetShelfLife: true })
      ).not.toThrow();
    });

    it('rejeita override para destinação MENOS restritiva sem decisão do cliente', () => {
      expect(() =>
        validateDispositionOverride({ suggested: 'QUARENTENA', confirmed: 'REINTEGRAR', physicalState: 'EMBALAGEM_VIOLADA', suggestionMetShelfLife: true })
      ).toThrow(LessRestrictiveDispositionOverrideError);
    });

    it('permite destinação menos restritiva com decisão formal do cliente (exceto reintegração vencida)', () => {
      expect(() =>
        validateDispositionOverride({
          suggested: 'DESCARTE',
          confirmed: 'RETORNO_CLIENTE',
          physicalState: 'VENCIDO',
          suggestionMetShelfLife: false,
          clientDecision: true,
        })
      ).not.toThrow();
    });

    it('NUNCA permite reintegrar item vencido — nem com decisão do cliente (cenário Gherkin DOC-07 §6)', () => {
      expect(() =>
        validateDispositionOverride({
          suggested: 'DESCARTE',
          confirmed: 'REINTEGRAR',
          physicalState: 'VENCIDO',
          suggestionMetShelfLife: false,
          clientDecision: true,
        })
      ).toThrow(ReintegrationOfExpiredItemDeniedError);
    });

    it('NUNCA permite reintegrar item abaixo do shelf life mínimo mesmo íntegro', () => {
      expect(() =>
        validateDispositionOverride({
          suggested: 'QUARENTENA',
          confirmed: 'REINTEGRAR',
          physicalState: 'INTEGRO',
          suggestionMetShelfLife: false,
          clientDecision: true,
        })
      ).toThrow(ReintegrationOfExpiredItemDeniedError);
    });
  });
});
