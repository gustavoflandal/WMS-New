// DOC-17 §5 (RF-TEL-001/RN-TEL-002) — painel de Detalhe de Etapa. Consumido
// pela tela da trilha (`trilha/[entity]/[entityId]`) ao clicar em QUALQUER
// etapa (DOC-17 §2 — "o clique sempre abre"). Renderiza o contrato ÚNICO
// devolvido por GET .../fluxo-operacional/:entity/:entityId/steps/:stepCode/detail
// (Sessão 10A) sem reinterpretar nada — o `mode` e as `actions` já vêm
// resolvidos pelo backend (RN-TEL-002); este componente só apresenta.
//
// "Ações disponíveis" (§2) é CONSULTIVO no backend — aqui é só INFORMATIVO
// (rótulo do que pode ser feito), nunca um botão que executa a ação: as
// telas de execução por tela (Parte B do DOC-17) ainda não existem. Não
// fingir uma funcionalidade que não existe.
import React from 'react';
import { CheckCircle2, Circle, CircleDot, ShieldAlert, type LucideIcon } from 'lucide-react';
import { StatusBadge, type StatusTone } from './StatusBadge';
import { cn } from '../utils/cn';

export type StepDetailMode = 'CONSULTA' | 'EXECUCAO' | 'PREVISAO' | 'BLOQUEADA';

export interface StepDetailAction {
  action: string;
  permission: string;
}

export interface StepDetailBlockingException {
  id: string;
  type: string;
  status: string;
}

export interface StepDetailCompletedBy {
  id: string;
  name: string;
}

export interface StepDetailData {
  entity: string;
  entity_id: string;
  document_number: string | null;
  flow_type: string;
  flow_status: string;
  step_code: string;
  mode: StepDetailMode;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  completed_by: StepDetailCompletedBy | null;
  blocking_exception: StepDetailBlockingException | null;
  content: Record<string, unknown>;
  actions: StepDetailAction[];
}

export interface StepDetailPanelProps {
  /** Rótulo textual da etapa (mesmo dicionário passado ao FlowTrail). */
  stepLabel: string;
  detail: StepDetailData;
  className?: string;
}

const MODE_VISUAL: Record<StepDetailMode, { tone: StatusTone; icon: LucideIcon; label: string }> = {
  CONSULTA: { tone: 'done', icon: CheckCircle2, label: 'Consulta' },
  EXECUCAO: { tone: 'pending', icon: CircleDot, label: 'Execução' },
  PREVISAO: { tone: 'neutral', icon: Circle, label: 'Previsão' },
  BLOQUEADA: { tone: 'blocked', icon: ShieldAlert, label: 'Bloqueada por exceção' },
};

const ACTION_LABELS: Record<string, string> = {
  ESTORNAR: 'Estornar',
  REGISTRAR_CONFERENCIA: 'Registrar conferência',
  FORMAR_PALETE: 'Formar palete',
  REGISTRAR_PUTAWAY: 'Registrar putaway',
  REGISTRAR_PICKING: 'Registrar picking',
  REGISTRAR_EMBALAGEM: 'Registrar embalagem',
  REGISTRAR_PESAGEM: 'Registrar pesagem',
  CONFIRMAR_DOCUMENTOS_FISCAIS: 'Confirmar documentos fiscais',
  REGISTRAR_CARREGAMENTO: 'Registrar carregamento',
  REGISTRAR_TRIAGEM: 'Registrar triagem',
  CONFIRMAR_DESTINACAO: 'Confirmar destinação',
};

const KEY_LABELS: Record<string, string> = {
  product_id: 'Produto',
  batch_id: 'Lote',
  batch_provisional: 'Lote provisório',
  qty: 'Quantidade',
  qty_ordered: 'Qtd. pedida',
  qty_reserved: 'Qtd. reservada',
  qty_picked: 'Qtd. separada',
  qty_short: 'Qtd. cortada',
  qty_packed: 'Qtd. embalada',
  qty_confirmed: 'Qtd. confirmada',
  qty_suggested: 'Qtd. sugerida',
  status: 'Status',
  created_at: 'Criado em',
  created_by: 'Criado por',
  assigned_to_user_id: 'Executante',
  conferente_user_id: 'Conferente',
  counted_by: 'Contado por',
  confirmed_by: 'Confirmado por',
  location_id_from: 'Endereço de origem',
  location_id_to: 'Endereço de destino',
  location_id_designated: 'Endereço sugerido',
  location_id_executed: 'Endereço executado',
  location_id: 'Endereço',
  override_reason: 'Motivo do override',
  lpn: 'LPN',
  vehicle_visit: 'Visita do veículo',
  dock: 'Doca',
  plate: 'Placa',
  driver_name: 'Motorista',
  gate_in_at: 'Entrada',
  gate_out_at: 'Saída',
  dock_at: 'Atracação em',
  seals_in: 'Lacres de entrada',
  seals_out: 'Lacres de saída',
  physical_state: 'Estado físico',
  disposition_suggested: 'Destinação sugerida',
  disposition_confirmed: 'Destinação confirmada',
  photo_keys: 'Fotos',
  theoretical_weight_kg: 'Peso teórico (kg)',
  actual_weight_kg: 'Peso pesado (kg)',
  weight_source: 'Origem do peso',
  weight_reason_text: 'Motivo do peso',
  fiscal_status: 'Status fiscal',
  access_key: 'Chave de acesso',
  scanned_lpn: 'LPN lido',
  result: 'Resultado',
  rejection_detail: 'Motivo da rejeição',
  mode_switch_reason: 'Motivo da troca de modo',
  qty_counted: 'Quantidade contada',
  round: 'Rodada',
  cycle: 'Ciclo',
  discrepancy_type: 'Tipo de divergência',
  resolution: 'Resolução',
  package_type_code: 'Tipo de embalagem',
  tare_kg: 'Tara (kg)',
  sequence_number: 'Sequência',
  route_sequence: 'Sequência da rota',
  reason_code: 'Motivo (código)',
  reason_text: 'Motivo (texto)',
  number: 'Número',
  recipient_name: 'Destinatário',
  recipient_document: 'Documento do destinatário',
  expected_dispatch_date: 'Previsão de expedição',
  contains_hazmat: 'Contém inflamável',
  contains_perishable: 'Contém perecível',
  wave_id: 'Onda',
  dock_type: 'Tipo de doca',
  code: 'Código',
  document_type: 'Tipo de documento',
  xml_storage_key: 'XML',
  started_at: 'Iniciado em',
  completed_at: 'Concluído em',
  tasks: 'Tarefas',
  packages: 'Pacotes',
  items: 'Itens',
  contents: 'Conteúdo',
  id: 'ID',
  package_id: 'ID do pacote',
  weighed_at: 'Pesado em',
  weight_exception_id: 'Exceção de peso',
  staged_at: 'Conferido no staging em',
  loaded_at: 'Carregado em',
};

function humanizeKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map((v) => String(v)).join(', ');
  if (typeof value === 'string' && isIsoTimestamp(value)) {
    return new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return String(value);
}

function ContentTable({ title, rows }: { title: string; rows: Record<string, unknown>[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div>
        <h3 className="mb-1 text-label text-text-secondary">{humanizeKey(title)}</h3>
        <p className="text-body text-text-secondary">Nenhum registro.</p>
      </div>
    );
  }
  const columns = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-2 text-label text-text-secondary">{humanizeKey(title)}</h3>
      <table className="w-full min-w-max border-collapse text-body">
        <thead className="bg-surface-sunken">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="border-b border-border-subtle p-2 text-left text-label text-text-secondary">
                {humanizeKey(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border-subtle">
              {columns.map((c) => (
                <td key={c} className="whitespace-nowrap p-2 font-mono text-data tabular-nums text-text-primary">
                  {formatValue(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValueBlock({ title, data }: { title: string; data: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(data);
  return (
    <div>
      {title ? <h3 className="mb-2 text-label text-text-secondary">{humanizeKey(title)}</h3> : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {entries.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-label text-text-secondary">{humanizeKey(k)}</dt>
            <dd className="font-mono text-data text-text-primary">{formatValue(v)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

function ContentSection({ content }: { content: Record<string, unknown> }): JSX.Element {
  const keys = Object.keys(content);
  if (keys.length === 0) {
    return <p className="text-body text-text-secondary">Nenhum dado registrado para esta etapa ainda.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {keys.map((key) => {
        const value = content[key];
        if (Array.isArray(value)) {
          if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            return <ContentTable key={key} title={key} rows={value as Record<string, unknown>[]} />;
          }
          return <KeyValueBlock key={key} title="" data={{ [key]: value }} />;
        }
        if (value !== null && typeof value === 'object') {
          return <KeyValueBlock key={key} title={key} data={value as Record<string, unknown>} />;
        }
        return <KeyValueBlock key={key} title="" data={{ [key]: value }} />;
      })}
    </div>
  );
}

export function StepDetailPanel({ stepLabel, detail, className }: StepDetailPanelProps): JSX.Element {
  const visual = MODE_VISUAL[detail.mode];

  return (
    <section aria-label={`Detalhe da etapa ${stepLabel}`} className={cn('flex flex-col gap-4 rounded-card border border-border-subtle bg-surface-raised p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-subtitle text-text-primary">{stepLabel}</h2>
        <StatusBadge tone={visual.tone} icon={visual.icon} label={visual.label} />
      </div>

      {detail.mode === 'PREVISAO' ? (
        <p role="status" className="text-body text-text-secondary">
          Esta etapa ainda não pode ser executada — conclua a etapa anterior. O conteúdo abaixo é o planejado, não o realizado.
        </p>
      ) : null}

      {detail.mode === 'BLOQUEADA' && detail.blocking_exception ? (
        <p role="alert" className="text-body text-state-blocked">
          Bloqueada pela exceção <span className="font-mono">{detail.blocking_exception.type}</span> (status {detail.blocking_exception.status}). Decida a exceção para liberar esta etapa.
        </p>
      ) : null}

      {detail.mode === 'CONSULTA' && detail.completed_by ? (
        <p className="text-body text-text-secondary">
          Concluída {detail.completed_at ? `em ${formatValue(detail.completed_at)}` : ''} por <span className="text-text-primary">{detail.completed_by.name}</span>.
        </p>
      ) : null}

      <ContentSection content={detail.content} />

      {detail.actions.length > 0 ? (
        <div className="border-t border-border-subtle pt-3">
          <h3 className="mb-2 text-label text-text-secondary">Ação disponível</h3>
          <div className="flex flex-wrap gap-2">
            {detail.actions.map((a) => (
              <span key={a.action} className="inline-flex h-[22px] items-center rounded-field bg-brand-subtle px-2 text-label text-brand">
                {ACTION_LABELS[a.action] ?? a.action}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
