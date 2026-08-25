// DOC-08 §4.7 RNF-FIS-060 — montagem do XML da NF-e (leiaute 4.00). Escopo
// desta sessão: subconjunto REPRESENTATIVO dos campos normativamente
// citados pelo DOC-08 (identificação, emitente, destinatário, itens,
// totais, chave de acesso com dígito verificador real) — não o leiaute
// oficial completo (centenas de campos de ICMS/PIS/COFINS/transporte por
// UF), que fica fora do escopo declarado da 8B (protocolo/motor, não
// tributação avançada — DOC-08 §8 exclui ST/DIFAL explicitamente).
export interface NfeXmlItem {
  lineNumber: number;
  productCode: string;
  description: string;
  ncm: string;
  cfop: string;
  qty: number;
  unitValue: number;
}

export interface BuildNfeXmlInput {
  fiscalDocumentId: string;
  cUF: string; // código IBGE da UF do emitente (2 dígitos)
  issuedAt: Date;
  issuerCnpj: string;
  issuerName: string;
  recipientCnpj: string;
  recipientName: string;
  serie: number;
  nfeNumber: number;
  tpemis: 'NORMAL' | 'SVC';
  items: NfeXmlItem[];
}

export interface BuiltNfeXml {
  accessKey: string;
  xml: string;
  totalValue: number;
}

/** RNF-FIS-060 — dígito verificador módulo 11 da chave de acesso (44 dígitos). */
export function calculateAccessKeyCheckDigit(base43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    sum += Number(base43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/**
 * Chave de 44 dígitos: cUF(2) AAMM(4) CNPJ(14) mod(2='55') serie(3) nNF(9)
 * tpEmis(1) cNF(8) DV(1). `cNF` (código numérico aleatório) é derivado
 * deterministicamente do fiscal_document.id para reprodutibilidade em
 * teste — não é o gerador criptográfico aleatório que a produção real
 * usaria, decisão de escopo documentada.
 */
export function buildAccessKey(input: BuildNfeXmlInput): string {
  const aamm = `${String(input.issuedAt.getUTCFullYear()).slice(2)}${String(input.issuedAt.getUTCMonth() + 1).padStart(2, '0')}`;
  const serie = String(input.serie).padStart(3, '0');
  const numero = String(input.nfeNumber).padStart(9, '0');
  const tpEmis = input.tpemis === 'SVC' ? '2' : '1';
  const cNF = deriveNumericCode(input.fiscalDocumentId, 8);
  const base43 = `${input.cUF}${aamm}${input.issuerCnpj}55${serie}${numero}${tpEmis}${cNF}`;
  const dv = calculateAccessKeyCheckDigit(base43);
  return `${base43}${dv}`;
}

function deriveNumericCode(seed: string, length: number): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return String(hash).padStart(length, '0').slice(-length);
}

/** Monta o envelope XML. `<simKey>` embutido carrega a chave de acesso — é assim que SefazSimulatorAdapter roteia a resposta configurada por teste (ver sefaz-simulator.adapter.ts). */
export function buildNfeEnvelopeXml(input: BuildNfeXmlInput): BuiltNfeXml {
  const accessKey = buildAccessKey(input);
  const totalValue = input.items.reduce((sum, item) => sum + item.qty * item.unitValue, 0);

  const detXml = input.items
    .map(
      (item) => `
    <det nItem="${item.lineNumber}">
      <prod>
        <cProd>${escapeXml(item.productCode)}</cProd>
        <xProd>${escapeXml(item.description)}</xProd>
        <NCM>${escapeXml(item.ncm)}</NCM>
        <CFOP>${escapeXml(item.cfop)}</CFOP>
        <qCom>${item.qty.toFixed(4)}</qCom>
        <vUnCom>${item.unitValue.toFixed(2)}</vUnCom>
        <vProd>${(item.qty * item.unitValue).toFixed(2)}</vProd>
      </prod>
    </det>`
    )
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${accessKey}" versao="4.00">
    <ide>
      <cUF>${input.cUF}</cUF>
      <mod>55</mod>
      <serie>${input.serie}</serie>
      <nNF>${input.nfeNumber}</nNF>
      <dhEmi>${input.issuedAt.toISOString()}</dhEmi>
      <tpEmis>${input.tpemis === 'SVC' ? '2' : '1'}</tpEmis>
    </ide>
    <emit>
      <CNPJ>${escapeXml(input.issuerCnpj)}</CNPJ>
      <xNome>${escapeXml(input.issuerName)}</xNome>
    </emit>
    <dest>
      <CNPJ>${escapeXml(input.recipientCnpj)}</CNPJ>
      <xNome>${escapeXml(input.recipientName)}</xNome>
    </dest>${detXml}
    <total>
      <ICMSTot>
        <vNF>${totalValue.toFixed(2)}</vNF>
      </ICMSTot>
    </total>
  </infNFe>
  <simKey>${accessKey}</simKey>
</NFe>`;

  return { accessKey, xml, totalValue };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
