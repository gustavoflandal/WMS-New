// DOC-11 RNF-PER-001 — WMS Edge Agent, processo standalone. Wrapper fino
// sobre EdgeAgentSimulator (implementação de referência, Entregável 7):
// conecta ao backend com o token de dispositivo e executa jobs simulados —
// útil para demonstrar o protocolo ponta a ponta sem hardware físico
// (`pnpm --filter @wms/edge-agent dev`). Não é o produto final de campo
// (drivers de hardware real são responsabilidade da implantação de cada
// armazém — RNF-PER-030..060 especificam os protocolos, não o binário).
import { EdgeAgentSimulator } from './simulator.js';

const backendUrl = process.env.BACKEND_WS_URL || 'http://localhost:3000';
const token = process.env.EDGE_AGENT_TOKEN;

if (!token) {
  console.error('EDGE_AGENT_TOKEN é obrigatório (token de dispositivo emitido por POST /perifericos/agentes)');
  process.exit(1);
}

const devices = (process.env.EDGE_AGENT_DEVICES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((deviceCode) => ({ deviceCode, status: 'ONLINE' as const }));

const simulator = new EdgeAgentSimulator({ backendUrl, token, devices });

simulator
  .connect()
  .then(() => console.log(`✓ Edge Agent conectado a ${backendUrl}/edge-agent`))
  .catch((err) => {
    console.error('Falha ao conectar ao backend:', err);
    process.exit(1);
  });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void simulator.disconnect().finally(() => process.exit(0));
  });
}
