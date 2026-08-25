// DOC-17 RF-TEL-022 — conteúdo por tipo de formulário (linhas "previsto",
// impressas no papel). Função pura: recebe os dados já carregados pelo
// service (SQL contra a tabela de cada módulo) e devolve só o que a coluna
// "Linhas contêm" de RF-TEL-022 permite — nunca o service monta isso ad hoc,
// para que a cegueira (RN-TEL-023 [INVIOLÁVEL]) seja verificável num só
// lugar, com teste dedicado, e não relembrada em cada chamador.
export type FieldFormType = 'PICKING' | 'PUTAWAY' | 'CONFERENCIA' | 'CONTAGEM' | 'REPOSICAO_TRANSFERENCIA' | 'CARREGAMENTO';

export interface PutawayLineInput {
  lpn: string;
  productDescription: string;
  locationSuggestedCode: string;
  alternativeCodes: string[];
}

export interface PickingLineInput {
  routeSequence: number;
  locationCode: string;
  productDescription: string;
  batchSuggested: string | null;
  expiryDate: string | null;
  qtySuggested: number;
  packagingCode: string;
}

export interface ConferenciaLineInput {
  expectedProductDescription: string | null;
  blindChecking: boolean;
}

export interface ContagemLineInput {
  locationCode: string;
}

export interface ReposicaoLineInput {
  originLocationCode: string;
  productDescription: string;
  batchSuggested: string | null;
  qty: number;
  destinationLocationCode: string;
}

export interface CarregamentoLineInput {
  lpn: string;
  sequence: string;
}

/** RF-TEL-022 "Putaway": LPN, produto/conteúdo, endereço sugerido e 4 alternativas. */
export function buildPutawayLineContent(input: PutawayLineInput): Record<string, unknown> {
  return {
    lpn: input.lpn,
    produto: input.productDescription,
    endereco_sugerido: input.locationSuggestedCode,
    alternativas: input.alternativeCodes,
  };
}

/** RF-TEL-022 "Picking": sequência da rota, endereço, produto, descrição, lote sugerido, validade, quantidade a separar, embalagem. */
export function buildPickingLineContent(input: PickingLineInput): Record<string, unknown> {
  return {
    sequencia_rota: input.routeSequence,
    endereco: input.locationCode,
    produto: input.productDescription,
    lote_sugerido: input.batchSuggested,
    validade: input.expiryDate,
    quantidade_a_separar: input.qtySuggested,
    embalagem: input.packagingCode,
  };
}

/**
 * RF-TEL-022 "Conferência": "(cega: sem quantidades) produto esperado ou
 * lista em branco conforme blind_checking". RN-TEL-023 [INVIOLÁVEL]: quando
 * cego, NÃO imprime a quantidade esperada — aqui nem existe campo de
 * quantidade em nenhum dos dois casos (a coluna nunca teve "quantidade
 * esperada" no catálogo, cega ou não; só varia se o produto aparece).
 */
export function buildConferenciaLineContent(input: ConferenciaLineInput): Record<string, unknown> {
  return {
    produto_esperado: input.blindChecking ? null : input.expectedProductDescription,
  };
}

/**
 * RF-TEL-022 "Contagem de inventário": "endereço, SEM saldo do sistema
 * (RN-COL-061 vale igualmente no papel)". RN-TEL-023 [INVIOLÁVEL]: nenhum
 * saldo do sistema, contagem anterior ou divergência pode constar — por
 * construção, esta função só aceita `ContagemLineInput` (que não tem esses
 * campos), então não há como um chamador futuro vazar saldo aqui sem
 * primeiro mudar esta assinatura (e o teste dedicado que a acompanha).
 */
export function buildContagemLineContent(input: ContagemLineInput): Record<string, unknown> {
  return {
    endereco: input.locationCode,
  };
}

/** RF-TEL-022 "Reposição/Transferência": origem, produto, lote, quantidade, destino. */
export function buildReposicaoLineContent(input: ReposicaoLineInput): Record<string, unknown> {
  return {
    origem: input.originLocationCode,
    produto: input.productDescription,
    lote: input.batchSuggested,
    quantidade: input.qty,
    destino: input.destinationLocationCode,
  };
}

/** RF-TEL-022 "Carregamento": volumes esperados com LPN e sequência n/N. */
export function buildCarregamentoLineContent(input: CarregamentoLineInput): Record<string, unknown> {
  return {
    lpn: input.lpn,
    sequencia: input.sequence,
  };
}
