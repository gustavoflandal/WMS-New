// DOC-08 §4.7 — adaptador de PRODUÇÃO (real, atrás da mesma interface do
// simulador). Estruturalmente completo, mas [DEBITO: 8B] não é exercitado
// pelos testes de integração desta sessão (este ambiente não tem acesso
// real à SEFAZ, nem em homologação — nenhum certificado A1 de empresa real
// disponível) — mesma decisão já tomada para o Edge Agent (DOC-11): o
// adaptador de produção existe e é testável isoladamente (unitário, sem
// rede), mas não é o caminho crítico validado por integração real. A
// assinatura que este adaptador aplica no envelope tem a limitação
// documentada em xml-dsig.util.ts (sem canonicalização C14N).
import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { SefazClientPort, SefazTransmitInput, SefazTransmitResult } from './sefaz-client.port.js';

/**
 * Endpoints reais por UF/ambiente não são cadastrados nesta sessão (exigiria
 * validar contra a tabela oficial de webservices da Receita, que muda por
 * UF e por SVC — SVAN/SVRS). Mapeamento mínimo ilustrativo, [DEBITO: 8B]
 * completar com a tabela oficial antes de qualquer uso em produção real.
 */
const SEFAZ_ENDPOINTS: Record<string, string> = {
  SP: 'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
};

@Injectable()
export class SefazSoapClientAdapter implements SefazClientPort {
  private readonly logger = new Logger(SefazSoapClientAdapter.name);
  private readonly parser = new XMLParser({ ignoreAttributes: false });

  async transmit(input: SefazTransmitInput): Promise<SefazTransmitResult> {
    const endpoint = SEFAZ_ENDPOINTS[input.uf];
    if (!endpoint) {
      throw new Error(`SefazSoapClientAdapter: endpoint não cadastrado para UF ${input.uf} — [DEBITO: 8B] tabela de webservices incompleta`);
    }

    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>${input.envelopeXml}</soap:Body>
</soap:Envelope>`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: soapEnvelope,
    });

    const text = await response.text();
    const parsed = this.parser.parse(text);
    const cStat = Number(this.findField(parsed, 'cStat') ?? 999);
    const cStatMessage = String(this.findField(parsed, 'xMotivo') ?? 'Resposta SEFAZ não reconhecida');
    const protocolNumber = this.findField(parsed, 'nProt') ? String(this.findField(parsed, 'nProt')) : null;

    return {
      cStat,
      cStatMessage,
      protocolNumber,
      authorizedAt: cStat === 100 ? new Date() : null,
    };
  }

  async checkAvailability(uf: string): Promise<boolean> {
    const endpoint = SEFAZ_ENDPOINTS[uf];
    if (!endpoint) return false;
    try {
      const response = await fetch(endpoint, { method: 'HEAD' });
      return response.ok;
    } catch (error) {
      this.logger.warn(`checkAvailability(${uf}) falhou: ${(error as Error).message}`);
      return false;
    }
  }

  /** Busca recursiva rasa por uma tag em qualquer profundidade — resposta SOAP tem namespaces variáveis por UF. */
  private findField(node: unknown, field: string): unknown {
    if (!node || typeof node !== 'object') return undefined;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === field || key.endsWith(`:${field}`)) return value;
      const nested = this.findField(value, field);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
}
