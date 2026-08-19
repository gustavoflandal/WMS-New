// DOC-06 RG-002/RN-EXP-011 — helper compartilhado pelos "tentar concluir
// etapa X" (picking/embalagem/pesagem/expedição/carregamento): a etapa só
// pode concluir quando é de fato a PRIMEIRA `PENDING` do fluxo (mesma regra
// de OperationFlowService.completeStep), não apenas quando SEU PRÓPRIO
// flow_step está `PENDING` — uma etapa fica PENDING até ser concluída,
// independente de etapas ANTERIORES já terem concluído ou não. Checar só o
// próprio status deixaria completeOrderStep() lançar FLOW_STEP_ORDER_VIOLATION
// sempre que a ação física (pesar, escanear) acontecesse antes da etapa
// anterior ter concluído — o que a operação real permite (nada aqui trava a
// pesagem física de acontecer cedo demais), então o "tentar concluir" deve
// ser um no-op silencioso nesse caso, não um erro.
import { PoolClient } from 'pg';

export async function isFirstPendingStep(client: PoolClient, orderId: string, stepCode: string): Promise<boolean> {
  const result = await client.query(
    `SELECT fs.step_code FROM wms.flow_step fs
     JOIN wms.operation_flow of ON of.id = fs.operation_flow_id
     WHERE of.entity = 'outbound_order' AND of.entity_id = $1 AND fs.status = 'PENDING'
     ORDER BY fs.sequence_order ASC LIMIT 1`,
    [orderId]
  );
  return result.rows[0]?.step_code === stepCode;
}
