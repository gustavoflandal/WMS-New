// DOC-02 RN-DAD-010 — "canal" físico de uma estrutura de armazenagem.
//
// Definição ÚNICA, compartilhada entre o motor de putaway (DOC-04 RN-REC-040
// filtro 6, Sessão 4B — entrada no canal) e a Seleção de Saldo (DOC-05
// RN-EST-011, Sessão 5B — saída do canal). As duas pontas PRECISAM concordar
// sobre o que é um canal: a 4B só deixa entrar lote homogêneo no canal
// LIFO_PHYSICAL justamente para que a 5B possa retirar dele sem violar a
// política de giro. Se as definições divergissem, a garantia da 4B não
// cobriria o que a 5B assume — por isso a definição vive aqui, em um único
// lugar, em vez de duplicada nos dois motores.
//
// [LACUNA herdada da 4B: DOC-02/DOC-05 não definem a fronteira física exata
// de "canal". Mantida a mesma inferência da Sessão 4B (a lane clássica de
// drive-in): mesmo equipamento + mesma rua + mesmo módulo + mesmo nível.
// Endereços sem equipamento (piso/blocado demarcado) formam um canal próprio
// por coordenada, nunca compartilhado com um equipamento real.]

export interface PhysicalChannelCoordinates {
  storageEquipmentId: string | null;
  aisle: string;
  module: string;
  level: string;
}

/** Chave determinística do canal físico — ver justificativa no cabeçalho. */
export function physicalChannelKey(coordinates: PhysicalChannelCoordinates): string {
  return `${coordinates.storageEquipmentId ?? 'NO_EQUIP'}|${coordinates.aisle}|${coordinates.module}|${coordinates.level}`;
}
