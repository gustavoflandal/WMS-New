// DOC-08 §4.7 RNF-FIS-060 — assinatura do XML da NF-e. Escopo desta sessão,
// documentado explicitamente (não é lacuna escondida):
//
// [DEBITO: 8B] Canonicalização XML C14N (Exclusive XML Canonicalization,
// exigida pelo padrão XML-DSig/W3C que a NF-e real usa) NÃO está
// implementada — nenhuma biblioteca de canonicalização XML foi aprovada
// nesta sessão (só `node-forge`, para PKCS12+RSA). A assinatura aqui é uma
// SIMPLIFICAÇÃO: SHA-256 do XML bruto (sem C14N) assinado com RSA-SHA256
// via a chave privada extraída do certificado A1. Isso é suficiente para o
// `SefazSoapClientAdapter` ser estruturalmente completo e testável
// isoladamente (unitário, sem rede — ver prompt da 8B §2.3: "o adaptador de
// produção fica implementado e testável isoladamente, mas não é o que os
// testes de integração exercitam"), mas NÃO produz uma assinatura
// XML-DSig válida perante a SEFAZ real. Fechar esse débito exige avaliar
// uma lib de canonicalização (ex. `xml-c14n`) contra DOC-00 §2.2 numa
// sessão futura, quando o adaptador real for de fato usado.
import * as forge from 'node-forge';
import { createSign } from 'node:crypto';

export interface ParsedCertificate {
  privateKeyPem: string;
  certificatePem: string;
  notAfter: Date;
}

/** Extrai chave privada + certificado de um PFX (PKCS12) usando node-forge. */
export function parsePfx(pfxBuffer: Buffer, password: string): ParsedCertificate {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag?.key) {
    throw new Error('parsePfx: chave privada não encontrada no certificado A1');
  }

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = certBags[forge.pki.oids.certBag]?.[0];
  if (!certBag?.cert) {
    throw new Error('parsePfx: certificado X.509 não encontrado no arquivo A1');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(keyBag.key),
    certificatePem: forge.pki.certificateToPem(certBag.cert),
    notAfter: certBag.cert.validity.notAfter,
  };
}

/**
 * Assinatura simplificada (ver aviso [DEBITO] no topo do arquivo): RSA-SHA256
 * sobre o XML bruto, sem canonicalização C14N. Retorna o XML com um bloco
 * `<Signature>` simplificado anexado.
 */
export function signXml(xml: string, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(xml, 'utf8');
  signer.end();
  const signature = signer.sign(privateKeyPem, 'base64');

  return xml.replace(
    '</NFe>',
    `  <Signature>
    <SignatureValue>${signature}</SignatureValue>
  </Signature>
</NFe>`
  );
}
