// DOC-17 RF-TEL-034 — Conferência de digitação (dupla digitação).
//
// "exige digitação em duas passagens independentes das quantidades, com
// divergência entre as passagens apontada ANTES de confirmar. Reduz o erro
// de transcrição, que é o risco central do modo papel."
//
// Função pura: a comparação das duas passagens não depende de banco nem de
// quem digitou. Fica aqui, testável isoladamente, em vez de embutida no
// service — é a única defesa contra o risco que o próprio DOC-17 §13
// classifica como "o principal do modo papel".
export interface DoubleEntryLine {
  lineNumber: number;
  /** Quantidade da 1ª passagem. */
  firstPass: number;
  /** Quantidade da 2ª passagem, digitada sem ver a primeira. */
  secondPass: number;
}

export interface DoubleEntryDivergence {
  lineNumber: number;
  firstPass: number;
  secondPass: number;
}

export interface DoubleEntryOutcome {
  /** true = as duas passagens batem em TODAS as linhas; pode confirmar. */
  matches: boolean;
  /** Linhas em que as passagens divergem — nada é gravado até resolver. */
  divergences: DoubleEntryDivergence[];
}

/**
 * Compara as duas passagens. RF-TEL-034 é explícito em "nada deve ser
 * gravado até a resolução": por isso o resultado é tudo-ou-nada
 * (`matches` só é true sem NENHUMA divergência), e não uma aplicação
 * parcial das linhas que bateram.
 */
export function compareDoubleEntry(lines: DoubleEntryLine[]): DoubleEntryOutcome {
  const divergences: DoubleEntryDivergence[] = [];
  for (const line of lines) {
    if (line.firstPass !== line.secondPass) {
      divergences.push({ lineNumber: line.lineNumber, firstPass: line.firstPass, secondPass: line.secondPass });
    }
  }
  return { matches: divergences.length === 0, divergences };
}

/**
 * RF-TEL-034 — a dupla digitação é exigida por TIPO de formulário
 * (parâmetro `TEL.DUPLA_DIGITACAO`, mapa tipo→booleano; "padrão true para
 * inventário"). Tipo ausente do mapa = não exigida.
 */
export function requiresDoubleEntry(formType: string, parameter: Record<string, boolean> | null): boolean {
  if (!parameter) return false;
  return parameter[formType] === true;
}
