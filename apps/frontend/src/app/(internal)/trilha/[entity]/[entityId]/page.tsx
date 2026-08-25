// DOC-10 RF-PAI-005 [O CORAÇÃO] + DOC-17 §2/§5 — tela da trilha: consome o
// contrato de estado (GET /fluxo-operacional/:entity/:entityId,
// OperationFlowService.getFlowState, Sessão 6A) para a trilha, e o contrato
// de detalhe (GET .../steps/:stepCode/detail, Sessão 10A) ao clicar em
// QUALQUER etapa — "o clique sempre abre" (DOC-17 §2), sem reinterpretar o
// modo/conteúdo devolvidos pelo backend. tenant_id vem da query string (o
// cartão do Painel já sabe o clientId ao navegar aqui).
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { FlowTrail, StepDetailPanel, type FlowStepData, type StepDetailData } from '@wms/ui';
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

  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [detail, setDetail] = useState<StepDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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

  // DOC-17 §2: QUALQUER etapa abre o detalhe — concluída, acionável,
  // bloqueada ou futura. O modo (Consulta/Execução/Previsão/Bloqueada) e o
  // conteúdo vêm inteiramente do backend (Sessão 10A); esta tela não decide
  // nada, só busca e apresenta.
  const handleStepOpen = useCallback(
    (step: FlowStepData) => {
      if (!warehouseId) return;
      setSelectedStep(step.step_code);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      apiClient
        .get<StepDetailData>(`/fluxo-operacional/${params.entity}/${params.entityId}/steps/${step.step_code}/detail?tenant_id=${tenantId}&warehouse_id=${warehouseId}`)
        .then(setDetail)
        .catch((err: unknown) => setDetailError(err instanceof ApiError ? err.message : 'Não foi possível carregar o detalhe da etapa.'))
        .finally(() => setDetailLoading(false));
    },
    [params.entity, params.entityId, tenantId, warehouseId]
  );

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

  const stepLabels = getStepLabels(state.flow.entity);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-mono text-display text-text-primary">{state.flow.entity_id}</h1>
        <p className="text-body text-text-secondary">
          {state.flow.entity} · {state.flow.status}
        </p>
      </div>

      <FlowTrail steps={state.steps} stepLabels={stepLabels} onStepOpen={handleStepOpen} />

      {selectedStep ? (
        <div aria-live="polite">
          {detailLoading ? <div className="h-32 animate-pulse rounded-card bg-surface-sunken motion-reduce:animate-none" aria-busy="true" /> : null}
          {detailError ? (
            <p role="alert" className="text-body text-state-pending">
              {detailError}
            </p>
          ) : null}
          {!detailLoading && !detailError && detail ? <StepDetailPanel stepLabel={stepLabels[selectedStep] ?? selectedStep} detail={detail} /> : null}
        </div>
      ) : null}
    </div>
  );
}
