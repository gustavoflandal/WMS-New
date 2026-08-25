// DOC-08 §4.7 RNF-FIS-060/061 — porta de transmissão à SEFAZ. Duas
// implementações: SefazSimulatorAdapter (usada pelos testes de integração
// e por padrão em docker-compose — este ambiente não tem acesso real à
// SEFAZ, nem em homologação) e SefazSoapClientAdapter (protocolo real,
// testável isoladamente, fora do caminho que os testes de integração
// exercitam — mesmo padrão já usado pelo simulador do Edge Agent, DOC-11).
export interface SefazTransmitInput {
  envelopeXml: string;
  ambiente: 'HOMOLOGACAO' | 'PRODUCAO';
  uf: string;
  /** RNF-FIS-061 — 'SVC' quando em contingência (tpEmis correspondente). */
  tpemis: 'NORMAL' | 'SVC';
}

export interface SefazTransmitResult {
  /** Código de status SEFAZ — 100 = autorizado; 2xx/9xx = rejeição; outros = denegação. */
  cStat: number;
  cStatMessage: string;
  protocolNumber: string | null;
  authorizedAt: Date | null;
}

export const SEFAZ_CLIENT_PORT = Symbol('SEFAZ_CLIENT_PORT');

export interface SefazClientPort {
  transmit(input: SefazTransmitInput): Promise<SefazTransmitResult>;
  /** RNF-FIS-061 — monitor de disponibilidade (poll a cada 5 min) para retomar o modo normal. */
  checkAvailability(uf: string, ambiente: 'HOMOLOGACAO' | 'PRODUCAO'): Promise<boolean>;
}
