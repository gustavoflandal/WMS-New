// DOC-08 §4.4 exemplo normativo (RG-014/RN-FIS-030): a mensagem de rejeição
// por saldo fiscal insuficiente é EXATA — "saldo fiscal disponível: 1.000"
// (separador de milhar '.', convenção pt-BR, mesma usada em todo o texto do
// documento) — teste de regressão permanente (CLAUDE.md §5). Intl embutido
// no Node (ICU completo desde Node 18) formata pt-BR nativamente, sem
// dependência nova.
export function formatBrNumber(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 }).format(value);
}
