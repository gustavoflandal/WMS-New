// DOC-10 RF-PAI-005 [O CORAÇÃO] — tela da trilha: consome o contrato ÚNICO
// GET /fluxo-operacional/:entity/:entityId (OperationFlowService.getFlowState,
// 6A) e renderiza FlowTrail sem reinterpretar estado algum. tenant_id vem da
// query string (o cartão do Painel já sabe o clientId ao navegar aqui).
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { FlowTrail, type FlowStepData } from '@wms/ui';
import { apiClient, ApiError } from '../../../../../lib/api-client';
import { getStepLabels } from '../../../../../lib/step-labels';
import { useAuth } from '../../../../../lib/auth-context';

interface FlowState {
  flow: {
    id: string;
    entity: string;
    entity_id: string;
    flow_type: string;
    status: string;
    warehouse_id: string;
    tenant_id: string;
    created_at: string;
  };
  steps: FlowStepData[];
}

export default function TrilhaPage(): JSX.Element {
  const params = useParams<{ entity: string; entityId: string }>();
  const searchParams = useSearchParams();
  const tenantId = searchParams.get('tenant_id') ?? '';
  const { warehouseId } = useAuth();
  const [state, setState] = useState<FlowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // [LACUNA: DOC-10 RF-PAI-005 descreve abrir "a operação" a partir da
  // etapa acionável, mas as telas de execução de cada operação (picking,
  // conferência, etc.) são de outras sessões/DOCs e não existem ainda nesta
  // área internal — só registramos qual etapa foi acionada, sem navegar.]
  const [lastAction, setLastAction] = useState<string | null>(null);

  const fetchState = useCallback(() => {
    if (!warehouseId) return;
    apiClient
      .get<FlowState>(`/fluxo-operacional/${params.entity}/${params.entityId}?tenant_id=${tenantId}&warehouse_id=${warehouseId}`)
      .then(setState)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar a trilha.'));
  }, [params.entity, params.entityId, tenantId, warehouseId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  if (error) {
    return (
      <p role="alert" className="text-body text-state-pending">
        {error}
      </p>
    );
  }

  if (!state) {
    return <div className="h-40 animate-pulse rounded-card bg-surface-sunken motion-reduce:animate-none" aria-busy="true" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-mono text-display text-text-primary">{state.flow.entity_id}</h1>
        <p className="text-body text-text-secondary">
          {state.flow.entity} · {state.flow.status}
        </p>
      </div>

      <FlowTrail
        steps={state.steps}
        stepLabels={getStepLabels(state.flow.entity)}
        onStepOpen={(step, mode) => setLastAction(`${step.step_code} (${mode})`)}
        onExceptionOpen={(exception) => setLastAction(`exceção ${exception.type} (${exception.id})`)}
        hasAlcadaForException={() => false}
      />

      {lastAction ? (
        <p className="text-label text-text-secondary">
          Último acionamento: {lastAction} — tela de execução fora do escopo desta sessão.
        </p>
      ) : null}
    </div>
  );
}
