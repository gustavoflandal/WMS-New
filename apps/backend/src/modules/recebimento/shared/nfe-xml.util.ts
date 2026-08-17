// DOC-04 RF-REC-010(a) — extração de itens, quantidades, lotes (quando
// presentes em `rastro`), emitente e chave de um XML de NF-e real
// (fast-xml-parser, não regex — NF-e tem múltiplos <det> aninhados,
// parsing por regex seria frágil). Cobre só os campos exigidos pelo
// RF-REC-010; [LACUNA: DOC-04 não exige validação de assinatura/schema
// XSD da NF-e — só extração de dados].
import { XMLParser } from 'fast-xml-parser';

export interface ParsedNfeItem {
  raw_sku: string;
  raw_ean: string | null;
  raw_description: string;
  raw_ncm: string | null;
  qty: number;
  batch_code: string | null;
  manufacture_date: string | null;
  expiration_date: string | null;
}

export interface ParsedNfe {
  access_key: string;
  issuer_cnpj: string;
  issuer_name: string;
  total_value: number;
  items: ParsedNfeItem[];
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Lança Error com mensagem prefixada RF-REC-010 se o XML não for uma NF-e reconhecível. */
export function parseNfeXml(xml: string): ParsedNfe {
  // parseTagValue (default true no fast-xml-parser) converteria campos
  // numéricos-mas-textuais (CNPJ, cProd, cEAN, NCM, chNFe) para JS Number,
  // derrubando silenciosamente zeros à esquerda (ex.: CNPJ "03817125008262"
  // -> 3817125008262, 13 dígitos) — bug real encontrado ao validar este
  // parser pela 1ª vez (nunca tinha sido testado contra um XML sintético).
  // Todos os campos numéricos deste parser já são convertidos
  // explicitamente via Number()/toString() logo abaixo, então desligar o
  // parsing automático é seguro.
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new Error(`RF-REC-010: XML inválido — ${(error as Error).message}`);
  }

  const nfeProc = doc.nfeProc ?? doc;
  const nfe = nfeProc.NFe ?? nfeProc;
  const infNFe = nfe?.infNFe;
  if (!infNFe) {
    throw new Error('RF-REC-010: XML não contém infNFe — não é uma NF-e reconhecível');
  }

  const idAttr: string = infNFe['@_Id'] ?? '';
  const chaveFromId = idAttr.replace(/^NFe/, '');
  const chaveFromProt: string | undefined = nfeProc.protNFe?.infProt?.chNFe;
  const accessKey = (chaveFromProt ?? chaveFromId ?? '').trim();
  if (!/^[0-9]{44}$/.test(accessKey)) {
    throw new Error(`RF-REC-010: chave de acesso da NF-e ausente ou inválida ("${accessKey}")`);
  }

  const emit = infNFe.emit ?? {};
  const issuerCnpj: string = (emit.CNPJ ?? '').toString().trim();
  const issuerName: string = (emit.xNome ?? '').toString().trim();
  if (!/^[0-9]{14}$/.test(issuerCnpj)) {
    throw new Error(`RF-REC-010: CNPJ do emitente ausente ou inválido ("${issuerCnpj}")`);
  }

  const totalValue = Number(infNFe.total?.ICMSTot?.vNF ?? 0);

  const detList = toArray(infNFe.det);
  const items: ParsedNfeItem[] = detList.map((det: any) => {
    const prod = det.prod ?? {};
    const rastro = det.rastro; // opcional — só presente quando o item tem lote/rastreabilidade
    return {
      raw_sku: (prod.cProd ?? '').toString().trim(),
      raw_ean: prod.cEAN && prod.cEAN !== 'SEM GTIN' ? prod.cEAN.toString().trim() : null,
      raw_description: (prod.xProd ?? '').toString().trim(),
      raw_ncm: prod.NCM ? prod.NCM.toString().trim() : null,
      qty: Number(prod.qCom ?? 0),
      batch_code: rastro?.nLote ? rastro.nLote.toString().trim() : null,
      manufacture_date: rastro?.dFab ?? null,
      expiration_date: rastro?.dVal ?? null,
    };
  });

  if (items.length === 0) {
    throw new Error('RF-REC-010: NF-e sem itens (<det>)');
  }

  return { access_key: accessKey, issuer_cnpj: issuerCnpj, issuer_name: issuerName, total_value: totalValue, items };
}
