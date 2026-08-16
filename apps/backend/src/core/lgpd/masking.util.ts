// DOC-12 RN-SEG-051 — mascaramento de CPF por padrão. Exemplo normativo do
// documento (§6 Gherkin): CPF 123.456.789-09 -> "***.456.789-**".
// [LACUNA: DOC-12 não dá um exemplo formatado para CNH — máscara análoga
// usada aqui (mesmos 3 blocos mascarados/visíveis/mascarados), documentado
// como inferência, não valor do documento.]

/** Extrai só os dígitos de um CPF/CNH formatado ou já numérico. */
function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** RN-SEG-051: 123.456.789-09 -> "***.456.789-**". */
export function maskCpf(cpf: string): string {
  const digits = onlyDigits(cpf);
  if (digits.length !== 11) {
    throw new Error(`CPF inválido para mascaramento: esperados 11 dígitos, recebido "${cpf}"`);
  }
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

/**
 * CNH (Carteira Nacional de Habilitação): 11 dígitos, sem separadores
 * padronizados. [LACUNA: DOC-12 não define o formato de máscara —
 * inferência análoga ao CPF: mantém um bloco central visível.]
 */
export function maskCnh(cnh: string): string {
  const digits = onlyDigits(cnh);
  if (digits.length !== 11) {
    throw new Error(`CNH inválida para mascaramento: esperados 11 dígitos, recebido "${cnh}"`);
  }
  return `***${digits.slice(3, 8)}***`;
}
