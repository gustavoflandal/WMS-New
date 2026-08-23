// DOC-11 RN-PER-020 — substituição de placeholders `${campo}` em templates
// ZPL. Função pura (sem I/O) para permitir teste unitário determinístico e
// reúso tanto por PeripheralJobService (impressão real) quanto por qualquer
// chamador que precise pré-visualizar o resultado.
const PLACEHOLDER_PATTERN = /\$\{([a-zA-Z0-9_]+)\}/g;

/** RN-PER-020: toda etiqueta ZPL suporta ${reprint_mark} mesmo quando o template não o exige (RF-PER-021). */
const ALWAYS_OPTIONAL_FIELDS = new Set(['reprint_mark']);

export function extractPlaceholders(content: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(PLACEHOLDER_PATTERN);
  while ((match = regex.exec(content)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * Valida que todos os `requiredFields` do template foram fornecidos ANTES
 * de renderizar — erro determinístico em vez de um placeholder literal
 * "${campo}" sobrevivendo na etiqueta física impressa.
 */
export function validateRequiredFields(requiredFields: string[], fields: Record<string, string>): void {
  const missing = requiredFields.filter((f) => fields[f] === undefined || fields[f] === null || fields[f] === '');
  if (missing.length > 0) {
    throw new Error(`RN-PER-020: campos obrigatórios ausentes para o template: ${missing.join(', ')}`);
  }
}

/** RN-PER-020: substitui ${campo} pelo valor fornecido; ${reprint_mark} ausente vira string vazia (etiqueta normal, não reimpressa). */
export function renderPlaceholders(content: string, fields: Record<string, string>): string {
  return content.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    if (fields[name] !== undefined && fields[name] !== null) return String(fields[name]);
    if (ALWAYS_OPTIONAL_FIELDS.has(name)) return '';
    throw new Error(`RN-PER-020: placeholder \${${name}} sem valor correspondente`);
  });
}
