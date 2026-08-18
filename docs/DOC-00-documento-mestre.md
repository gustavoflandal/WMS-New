# DOC-00 — DOCUMENTO MESTRE
## Especificação de Requisitos do Sistema WMS Enterprise 3PL
### Documento de Governança da Especificação — Fonte Canônica de Vocabulário, Convenções e Regras Globais

| Metadado | Valor |
|---|---|
| Código do documento | DOC-00 |
| Versão | 1.4.0 |
| Status | APROVADO PARA USO |
| Data | 2026-08-10 |
| Público-alvo | IA geradora de código e arquitetos humanos revisores |
| Idioma canônico | Português do Brasil (pt-BR) |
| Precedência | Este documento PREVALECE sobre qualquer outro em caso de conflito |

---

## 1. PROPÓSITO E INSTRUÇÕES PARA A IA GERADORA

### 1.1 Propósito

Este documento é o **contrato-mestre** da especificação do sistema WMS (Warehouse Management System) para operação 3PL multi-empresa e multi-armazém. Ele define o vocabulário canônico, as convenções de escrita de requisitos, as decisões arquiteturais congeladas e as regras invioláveis que governam TODOS os documentos-módulo (DOC-01 a DOC-13).

### 1.2 Instruções obrigatórias para a IA geradora de código

```
INSTRUÇÃO-IA-001: Você NÃO PODE inferir, inventar ou assumir regras de negócio
ausentes desta especificação. Ao encontrar lacuna, gere o marcador
[LACUNA: <descrição da informação ausente>] no código/documentação e PARE a
implementação daquele ponto específico, prosseguindo com o restante.

INSTRUÇÃO-IA-002: Todo requisito possui ID único e imutável (ex.: RF-EXP-014).
Todo artefato de código gerado a partir de um requisito DEVE referenciar o ID
em comentário no ponto de implementação.

INSTRUÇÃO-IA-003: Em caso de conflito entre documentos, a ordem de precedência
é: DOC-00 > documento do módulo específico > documentos de outros módulos.
Conflitos detectados DEVEM ser reportados como [CONFLITO: DOC-X §n vs DOC-Y §m].

INSTRUÇÃO-IA-004: Os termos definidos no Glossário (§4) têm significado ÚNICO.
É PROIBIDO usar sinônimos no código, no banco de dados e na interface.
O nome técnico (em inglês, coluna "Identificador técnico") é obrigatório em
código/banco; o nome de exibição (pt-BR) é obrigatório na interface.

INSTRUÇÃO-IA-005: Requisitos marcados como [INVIOLÁVEL] não podem ser
flexibilizados por nenhum requisito posterior, configuração ou perfil de
usuário, exceto quando o próprio requisito definir a exceção.

INSTRUÇÃO-IA-006: Nada fora do escopo declarado (§8 de cada módulo) deve ser
implementado, mesmo que pareça "óbvio" ou "boa prática".
```

### 1.3 O que este documento NÃO é

- Não é documento de arquitetura detalhada (ver DOC-01).
- Não é dicionário de dados (ver DOC-02).
- Não contém requisitos funcionais de módulos operacionais (ver DOC-03 a DOC-13).

---

## 2. VISÃO GERAL DO SISTEMA

### 2.1 Descrição em um parágrafo

O sistema é um **WMS Enterprise para operadores logísticos (3PL)** que gerencia até 50 armazéns simultâneos, atendendo múltiplas empresas-clientes por armazém, cobrindo o ciclo completo: portaria → pátio → doca → recebimento/conferência → armazenagem dirigida → gestão de estoque (FIFO/FEFO/LIFO, shelf life, segregações legais) → pedidos → picking → packing → pesagem → expedição → carregamento → saída, além de cross-docking, logística reversa, inventários, emissão fiscal opcional por cliente, faturamento de serviços de armazenagem, painel de operações pendentes em tempo real e integração com ERPs via conectores.

### 2.2 Stack tecnológica congelada

| Camada | Tecnologia | Observação vinculante |
|---|---|---|
| Frontend | Next.js (React) + Tailwind CSS | PWA offline-first para coletores/tablets |
| Backend | Node.js + NestJS | API REST + WebSocket |
| Banco de dados | PostgreSQL ≥ 16 | Multi-tenancy por Row-Level Security (RLS) |
| Cache / Eventos | Redis | Cache, Pub/Sub e Streams |
| Periféricos | WMS Edge Agent (serviço local) | Ponte navegador ↔ hardware (DOC-11) |

É **PROIBIDO** introduzir outras linguagens, frameworks de UI, bancos de dados ou brokers de mensageria sem alteração formal deste documento.

### 2.3 Números de dimensionamento (base para requisitos não-funcionais do DOC-01)

| Métrica | Valor de projeto |
|---|---|
| Armazéns simultâneos | 50 (máximo) |
| Usuários concorrentes (total) | 4.000 |
| Pedidos por dia (total) | 50.000 |
| SKUs no catálogo global | 2.000.000 |
| Posições de estoque por armazém | 20.000 |
| Latência-alvo de eventos em tempo real | ≤ 2 segundos (P95) |

---

## 3. DECISÕES ARQUITETURAIS CONGELADAS (ADR-RESUMO)

Estas decisões foram aprovadas pelo cliente e são **imutáveis** para efeito de geração do sistema. O detalhamento técnico de cada uma está no DOC-01.

| ID | Decisão | Resumo vinculante |
|---|---|---|
| AD-001 | Multi-tenancy | Modelo 3PL: N empresas-clientes × N armazéns; armazém compartilhado entre clientes. Isolamento por RLS no PostgreSQL com `tenant_id` obrigatório em toda tabela transacional. |
| AD-002 | Fiscal híbrido | Flag por cliente: `EMISSAO_PROPRIA`, `INTEGRADO_ERP` ou `HIBRIDO`. Motor fiscal isolado em módulo próprio (DOC-08). |
| AD-003 | Faturamento | Motor de tarifação por contrato (palete/dia, m³, movimentação, seguro ad valorem, avulsos) gerando pré-faturas. SEM gateway de pagamento. SEM dados de cartão. |
| AD-004 | Permissões | RBAC multi-dimensional: permissão = papel × empresa × armazém, com alçadas. Portal do cliente externo como aplicação separada. |
| AD-005 | Campo/offline | PWA offline-first com fila de sincronização em IndexedDB. Resolução de conflitos por regras determinísticas (nunca last-write-wins em estoque). |
| AD-006 | Putaway | Motor de regras com precedência configurável por armazém. Override permitido apenas com permissão `PUTAWAY_OVERRIDE`; motivo obrigatório; log integral. |
| AD-007 | Exceções | Toda exceção operacional passa por workflow de aprovação configurável por perfil, com trilha de auditoria completa. |
| AD-008 | Periféricos | Navegador NUNCA comunica diretamente com hardware. Toda comunicação via WMS Edge Agent (DOC-11). |
| AD-009 | Tempo real | WebSocket como canal principal, fallback SSE. Backbone de eventos: Redis Pub/Sub + Streams. |
| AD-010 | Integração ERP | Núcleo canônico de eventos + conectores plugáveis por cliente. WMS é source of truth do estoque físico. Reconciliação de saldo diária. |

---

## 3.1 MODOS DE OPERAÇÃO

O sistema atende dois cenários de negócio com a MESMA base de código e o
MESMO modelo de dados. O modo é definido na instalação pelo parâmetro global
`APP.MODO_OPERACAO` (escopo `GLOBAL`, valores `TRES_PL` | `PROPRIO`; padrão
`TRES_PL`).

| Aspecto | `TRES_PL` (armazém geral / operador logístico) | `PROPRIO` (armazém da própria empresa) |
|---|---|---|
| Relação operador × cliente | N clientes depositantes distintos do operador | 1 único Cliente, cujo CNPJ é o mesmo do Armazém |
| Multi-tenancy (AD-001/RG-001) | Ativo com N tenants | Ativo com 1 tenant — RLS permanece habilitada e obrigatória |
| Estoque Fiscal (RG-014) | Ativo conforme `fiscal_mode` do cliente | **Não aplicável**: não há remessa para armazém de terceiros (não há mudança de posse). `fiscal_mode = INTEGRADO_ERP`; o ERP da empresa responde pelo fiscal |
| Faturamento de serviços (DOC-09) | Ativo por contrato | Sem contrato cadastrado ⇒ nenhuma apuração nem Pré-Fatura |
| Portal do cliente (AD-004) | Ativo | Opcional (uso por filiais/departamentos como consulta) |
| Armazém Lógico (RG-015) | Área dedicada por cliente | Opcional, para segregar linhas de negócio/marcas no mesmo galpão |
| Demais módulos (03, 04, 05, 06, 07, 10, 11, 15) | Idênticos | Idênticos |

**RG-016 — Comportamento por modo de operação [INVIOLÁVEL]**
1. O modo NÃO altera o modelo de dados, o isolamento por RLS nem qualquer
   regra global: `PROPRIO` é o caso particular de `TRES_PL` com um único
   tenant. É PROIBIDO criar caminho de código alternativo, desabilitar RLS ou
   omitir `tenant_id` em modo `PROPRIO`.
2. ONDE `APP.MODO_OPERACAO = PROPRIO`, a interface DEVE ocultar seletores,
   filtros e colunas de Cliente, assumindo implicitamente o único Cliente
   ativo; a API mantém os campos, com o `client_id` resolvido pelo servidor
   quando omitido.
3. ONDE `APP.MODO_OPERACAO = PROPRIO`, o cadastro de um SEGUNDO Cliente ativo
   DEVE ser rejeitado com erro determinístico, orientando a troca para
   `TRES_PL`.
4. A troca de `PROPRIO` para `TRES_PL` é permitida a qualquer momento. A troca
   inversa exige exatamente um Cliente ativo e ausência de contratos de
   serviço vigentes; caso contrário é rejeitada.
5. Módulos inaplicáveis ao modo (Estoque Fiscal e Faturamento em `PROPRIO`)
   permanecem instalados e desativados por configuração — é PROIBIDO removê-los
   do build ou condicionar sua existência ao modo.

## 4. GLOSSÁRIO CANÔNICO

### 4.1 Regras do glossário

- **REG-GLO-001 [INVIOLÁVEL]:** cada termo tem UM significado. Sinônimos listados na coluna "Sinônimos proibidos" NÃO podem aparecer em código, banco ou interface.
- **REG-GLO-002:** o "Identificador técnico" é o nome obrigatório para entidades, tabelas, DTOs e enums. O "Termo" (pt-BR) é o nome obrigatório de exibição na interface.
- **REG-GLO-003:** termos novos só podem ser criados por adição formal a este glossário (nova versão do DOC-00).

### 4.2 Entidades organizacionais

| Termo | Identificador técnico | Definição única | Sinônimos proibidos |
|---|---|---|---|
| Operador Logístico | `logistics_operator` | A organização dona do sistema e dos armazéns; presta serviços de armazenagem a Clientes. Existe apenas 1 por instalação. Em modo `PROPRIO` (§3.1), é a própria empresa dona das mercadorias. | operadora, empresa-mãe |
| Modo de Operação | `operation_mode` | Configuração global de instalação: `TRES_PL` (armazém geral, N clientes) ou `PROPRIO` (armazém da própria empresa, 1 cliente). Ver §3.1 e RG-016. | modo, perfil de uso |
| Cliente | `client` | Empresa-cliente do operador logístico (depositante), dona de mercadorias armazenadas. Corresponde ao `tenant_id`. | empresa, depositante, terceiro |
| Armazém | `warehouse` | Instalação física de armazenagem operada pelo operador logístico. Um armazém atende N clientes. | CD, centro de distribuição, filial, depósito, galpão |
| Armazém Lógico | `logical_warehouse` | Partição virtual opcional dentro de um único Armazém físico, dedicada com exclusividade a um único Cliente, composta por zonas/endereços vinculados. Não possui portaria, pátio ou docas próprios. Máximo de 1 por par (cliente, armazém físico). | armazém virtual, sub-armazém, área dedicada |
| Usuário | `user` | Pessoa autenticável no sistema (interno ou do portal do cliente). | operador (ver "Operador de Campo"), colaborador |
| Operador de Campo | `field_operator` | Usuário interno que executa tarefas físicas (conferência, picking, putaway etc.). | operador, funcionário |
| Papel | `role` | Conjunto nomeado de permissões (RBAC). | perfil, cargo, grupo |
| Alçada | `approval_authority` | Limite quantitativo/qualitativo de autorização vinculado a papel + empresa + armazém. | limite, autonomia |

### 4.3 Estrutura física e endereçamento

| Termo | Identificador técnico | Definição única | Sinônimos proibidos |
|---|---|---|---|
| Zona | `zone` | Subdivisão lógica do armazém com finalidade e regras próprias (ex.: recebimento, quarentena, inflamáveis, picking, expedição). | área, setor, região |
| Estrutura de Armazenagem | `storage_equipment` | Equipamento físico instalado: porta-paletes, drive-in, drive-thru, cantilever, flowrack, estante, gaveteiro, carrossel, blocado. | rack (usar apenas em tipo específico) |
| Endereço | `location` | Menor unidade endereçável de armazenagem (posição), com coordenada padrão Rua-Módulo-Nível-Vão. | posição, slot, local, vaga (reservada para pátio) |
| Doca | `dock` | Ponto físico de acoplamento de veículo para carga ou descarga. | plataforma, baia (reservada para pátio) |
| Vaga de Pátio | `yard_slot` | Posição de espera de veículo no pátio. | baia, box |
| Capacidade | `location_capacity` | Limites físicos de um endereço: peso (kg), volume (m³), quantidade de paletes, altura (m). | — |

### 4.4 Mercadoria e estoque

| Termo | Identificador técnico | Definição única | Sinônimos proibidos |
|---|---|---|---|
| Produto | `product` | Item de catálogo pertencente a um Cliente, identificado por SKU único no escopo do cliente. | item, material, mercadoria (uso apenas coloquial em textos, nunca em código) |
| SKU | `sku` | Código identificador do produto no escopo do cliente. Chave natural: (`client_id`, `sku`). | código do produto |
| Espécie de Produto | `product_species` | Classificação regulatória/física que dita segregação e manuseio: `GERAL`, `MEDICAMENTO`, `ALIMENTO`, `INFLAMAVEL`, `COMBUSTIVEL`, `QUIMICO_CONTROLADO`, `REFRIGERADO`, `CONGELADO`, `FRAGIL`, `VALIOSO`. Lista extensível apenas via DOC-02. | categoria (ver "Categoria Comercial"), classe, tipo |
| Categoria Comercial | `commercial_category` | Classificação mercadológica livre definida pelo cliente (ex.: bebidas, higiene). NÃO dita segregação. | categoria |
| Lote | `batch` | Agrupamento de unidades de um produto com mesma origem de fabricação; atributos: código do lote, data de fabricação, data de validade. | partida |
| Validade | `expiration_date` | Data-limite de uso do lote. | vencimento, shelf life (ver termo próprio) |
| Shelf Life Mínimo | `min_shelf_life` | Percentual ou nº de dias mínimo de vida útil restante exigido para expedição, configurável por cliente/produto. | — |
| Palete | `pallet` | Unidade de movimentação identificada por LPN. | pálete, pallet (grafia), UMA |
| LPN | `lpn` | License Plate Number: identificador único global de palete/volume, materializado em etiqueta QR Code + Código 128 (DOC-11). | etiqueta de palete, ID do palete |
| Saldo de Estoque | `stock_balance` | Quantidade de um produto/lote em um endereço, decomposta em: disponível, reservado, bloqueado, em quarentena, avariado, em trânsito interno. | estoque (uso genérico proibido em código) |
| Estoque de Segurança | `safety_stock` | Quantidade mínima parametrizável por produto × armazém que dispara alerta/reposição. | estoque mínimo |
| Kanban | `kanban` | Método opcional de reposição por cartões/gatilhos parametrizável por produto × zona de picking. | — |
| Reserva | `stock_reservation` | Vínculo de quantidade de saldo a um documento (pedido, transferência), tornando-a indisponível para outras operações. | empenho, alocação (ver "Alocação de Doca") |

### 4.5 Documentos e operações

| Termo | Identificador técnico | Definição única | Sinônimos proibidos |
|---|---|---|---|
| Agendamento | `appointment` | Reserva de janela de data/hora para chegada de veículo (recebimento ou expedição). | agenda, booking |
| ASN | `asn` | Advance Shipping Notice: aviso prévio de recebimento contendo itens esperados; pode originar de XML de NF-e ou de integração ERP. | pré-recebimento, aviso de embarque |
| Ordem de Recebimento | `inbound_order` | Documento interno que consolida a operação de entrada (do check-in à conclusão do putaway). | recebimento (ação), entrada |
| Conferência | `checking` | Verificação física de itens contra documento (cega ou informada). | checagem, contagem (reservada a inventário) |
| Divergência | `discrepancy` | Diferença apurada em conferência: `FALTA`, `SOBRA`, `AVARIA`, `TROCA`, `SEM_CADASTRO`. | inconsistência, diferença |
| Putaway | `putaway` | Movimentação de armazenagem do recebimento ao endereço destino. | guarda, endereçamento (reservado à estrutura), estocagem |
| Cross-Docking | `cross_docking` | Fluxo em que a mercadoria recebida é destinada diretamente à expedição sem armazenagem em endereço de estoque. | — |
| Pedido | `outbound_order` | Documento de saída solicitado pelo cliente (venda, transferência externa, devolução ao cliente). Origem: portal, API ou ERP. | ordem de venda, OS (proibido), pedido de venda |
| Onda | `wave` | Agrupamento de pedidos liberados juntos para picking. | lote de separação |
| Picking | `picking` | Coleta física dos itens de um pedido/onda nos endereços. | separação, coleta |
| Packing | `packing` | Embalagem e volumação dos itens coletados. | embalagem (ação) |
| Pesagem | `weighing` | Aferição de peso de volume/palete/veículo em balança integrada. | — |
| Expedição | `dispatch` | Etapa de consolidação e liberação documental da carga na área de expedição. | despacho |
| Carregamento | `loading` | Colocação física dos volumes no veículo na doca. | embarque |
| Saída | `gate_out` | Liberação do veículo na portaria com baixa definitiva. | — |
| Logística Reversa | `reverse_logistics` | Fluxo de retorno de mercadoria (devolução, recall, avaria em trânsito) com triagem e destinação. | devolução (é um subtipo) |
| Inventário | `inventory_count` | Processo formal de contagem de estoque. Tipos: `GERAL`, `ROTATIVO_PRODUTO`, `ROTATIVO_DIA`, `POR_SORTEIO`, `POR_ZONA`, `POR_ESPECIE`, `POR_ENDERECO`. | balanço, contagem (é a ação dentro do inventário) |
| Transferência | `stock_transfer` | Movimentação de saldo entre endereços, zonas ou armazéns (com ou sem documento fiscal, conforme DOC-08). | remanejo |
| Tarefa | `task` | Unidade atômica de trabalho atribuível a um operador de campo (ex.: uma linha de picking, um putaway). | atividade, job |
| Fluxo Operacional | `operation_flow` | Máquina de estados sequencial de uma operação, exibida no Painel de Operações (§6). | esteira, pipeline, workflow (reservado a aprovações) |
| Workflow de Aprovação | `approval_workflow` | Sequência de aprovações por alçada para exceções. | — |
| Pré-Fatura | `pre_invoice` | Documento de apuração de serviços de armazenagem para conferência do cliente antes do faturamento (DOC-09). | fatura prévia |

### 4.6 Portaria e pátio

| Termo | Identificador técnico | Definição única | Sinônimos proibidos |
|---|---|---|---|
| Check-in de Portaria | `gate_in` | Registro de entrada de pessoa, veículo ou carga na portaria. | entrada |
| Visitante | `visitor` | Pessoa não-usuária registrada na portaria. | — |
| Motorista | `driver` | Condutor de veículo, identificado por CPF e CNH. | — |
| Veículo | `vehicle` | Ativo rodoviário identificado por placa (padrão Mercosul ou anterior). | caminhão (é um tipo) |
| Fila de Pátio | `yard_queue` | Ordem de atendimento dos veículos aguardando doca, por prioridade configurável. | — |

### 4.7 Estoque fiscal e documentos de armazenagem em terceiros

| Termo | Identificador técnico | Definição única | Sinônimos proibidos |
|---|---|---|---|
| Nota Fiscal de Entrada | `inbound_invoice` | NF-e de compra em nome do Cliente que acompanha a mercadoria na chegada ao armazém. Valida a posse do produto pelo armazém apenas por um período limitado e configurável. | nota de compra, DANFE (é a representação impressa) |
| Nota de Armazenagem | `storage_remittance_invoice` | NF-e emitida pelo Cliente de remessa para armazenagem em armazém de terceiros, que valida a permanência da mercadoria por tempo indeterminado e **carrega o estoque fiscal**. Vinculada obrigatoriamente à(s) Nota(s) Fiscal(is) de Entrada que a originaram. | nota de remessa |
| Nota de Devolução de Armazenagem | `storage_return_invoice` | NF-e emitida pelo armazém na saída da mercadoria (devolução simbólica/física de produto armazenado em armazém de terceiros), citando obrigatoriamente, **em cada item**, o número da Nota de Armazenagem de entrada que está sendo baixada. | nota de retorno, nota de saída |
| Estoque Fiscal | `fiscal_stock_balance` | Saldo de quantidade de um produto vinculado a uma Nota de Armazenagem específica. Dimensão paralela e independente do Saldo de Estoque físico. Chave: (`client_id`, `warehouse_id`, `product_id`, `storage_remittance_invoice_id`). | saldo documental |
| Alocação Fiscal | `fiscal_allocation` | Vínculo, no picking/expedição, entre a quantidade expedida de um item e a(s) Nota(s) de Armazenagem cujo estoque fiscal será consumido. | baixa fiscal (é o efeito) |

### 4.8 Convenção de estados (enums canônicos)

- **REG-GLO-004 [INVIOLÁVEL]:** estados de entidades são enums em SCREAMING_SNAKE_CASE em inglês no código/banco, com tradução de exibição pt-BR mantida em tabela de i18n. Exemplo — Pedido: `DRAFT`, `RELEASED`, `IN_PICKING`, `PICKED`, `IN_PACKING`, `PACKED`, `WEIGHED`, `IN_DISPATCH`, `IN_LOADING`, `LOADED`, `GATE_OUT`, `COMPLETED`, `CANCELLED`. Os enums definitivos de cada entidade estão nos documentos de módulo; a IA geradora NÃO PODE criar estados ausentes.

---

## 5. MAPA DE MÓDULOS E DEPENDÊNCIAS

### 5.1 Índice de documentos

| Doc | Título | Conteúdo | Depende de |
|---|---|---|---|
| DOC-00 | Documento Mestre | Este documento | — |
| DOC-01 | Arquitetura e Infraestrutura | Stack, RLS, eventos, WebSocket, PWA offline, Edge Agent (visão), observabilidade, NFRs | DOC-00 |
| DOC-02 | Modelo de Dados e Cadastros | Dicionário de dados, cadastros base, endereçamento | DOC-00, DOC-01 |
| DOC-03 | Portaria e Pátio | Gate-in/gate-out, agendamento, fila de pátio, LPR/cancelas | DOC-02 |
| DOC-04 | Recebimento e Docas | Docas, conferência, divergências, putaway, cross-docking | DOC-02, DOC-03 |
| DOC-05 | Estoque e Movimentação | Políticas de giro, shelf life, segurança, kanban, transferências, segregação, inventários | DOC-02, DOC-04 |
| DOC-06 | Expedição | Pedido→onda→picking→packing→pesagem→expedição→carregamento→saída; máquina de estados do Fluxo Operacional | DOC-02, DOC-05 |
| DOC-07 | Logística Reversa | Devoluções, triagem, reintegração/descarte | DOC-04, DOC-05 |
| DOC-08 | Fiscal | Modos por cliente, NF-e, eventos SEFAZ, contingência, guarda de XML | DOC-02 |
| DOC-09 | Faturamento de Serviços | Contratos, tarifas, apuração, pré-fatura | DOC-02, DOC-05 |
| DOC-10 | Painéis e Tempo Real | Painel de Operações Pendentes, dashboards, KPIs | DOC-01, DOC-06 |
| DOC-11 | Etiquetas e Periféricos | Templates ZPL, GS1, protocolo do Edge Agent, balanças, cancelas, LPR | DOC-01 |
| DOC-12 | Segurança, Permissões e Auditoria | RBAC multi-dimensional, alçadas, logs de operação, LGPD | DOC-01, DOC-02 |
| DOC-13 | Integrações | API pública, contratos canônicos, webhooks, conectores ERP, reconciliação | DOC-01, DOC-02 |

### 5.2 Ordem de geração recomendada para a IA

```
Fase 1 (fundação):    DOC-01 → DOC-02 → DOC-12
Fase 2 (inbound):     DOC-03 → DOC-04 → DOC-05
Fase 3 (outbound):    DOC-06 → DOC-10
Fase 4 (complementos): DOC-07 → DOC-08 → DOC-09 → DOC-11 → DOC-13
```

---

## 6. REGRAS GLOBAIS INVIOLÁVEIS

Estas regras aplicam-se a TODOS os módulos e prevalecem sobre qualquer requisito local.

### RG-001 — Isolamento de tenant [INVIOLÁVEL]
QUANDO qualquer consulta ou comando acessar tabela transacional, o sistema DEVE aplicar filtro de `tenant_id` via RLS no PostgreSQL, E o backend DEVE definir o contexto de tenant na conexão antes de qualquer query. É PROIBIDO desabilitar RLS em runtime. Usuários internos do operador logístico com papel adequado podem operar em modo multi-tenant explícito (lista de tenants autorizados), nunca em modo "todos".

### RG-002 — Fluxo sequencial sem salto de etapas [INVIOLÁVEL]
QUANDO um Fluxo Operacional estiver em execução, o sistema DEVE permitir a abertura/execução apenas da etapa imediatamente posterior à última etapa concluída. Etapas concluídas são exibidas em **verde**; pendentes em **vermelho**; a única etapa clicável é a primeira pendente. É PROIBIDO pular etapas por qualquer meio (interface, API ou importação). Retrocessos exigem estorno formal com workflow de aprovação (AD-007).

### RG-003 — Rastreabilidade total (auditoria) [INVIOLÁVEL]
QUANDO qualquer operação alterar estado de estoque, documento ou cadastro sensível, o sistema DEVE registrar log imutável contendo: timestamp UTC, `tenant_id`, `warehouse_id`, `user_id`, dispositivo/origem, entidade, ID do requisito de negócio aplicável, valores ANTES e DEPOIS, e motivo (quando exigido). Logs não podem ser alterados nem excluídos por nenhum papel. Detalhamento no DOC-12.

### RG-004 — Estoque nunca negativo [INVIOLÁVEL]
QUANDO uma movimentação resultar em saldo disponível negativo em qualquer decomposição do Saldo de Estoque, o sistema DEVE rejeitar a transação com erro determinístico. Não existe configuração que permita saldo negativo.

### RG-005 — Segregação por espécie [INVIOLÁVEL]
QUANDO um putaway, transferência ou alocação sugerir/aceitar endereço, o sistema DEVE validar a matriz de compatibilidade de Espécies de Produto (DOC-05). Incompatibilidades legais (ex.: `MEDICAMENTO` × `QUIMICO_CONTROLADO`; `INFLAMAVEL`/`COMBUSTIVEL` fora de zona classificada) NÃO admitem override por nenhum papel. Incompatibilidades operacionais admitem override apenas com permissão específica + motivo + log.

### RG-006 — Política de giro por produto [INVIOLÁVEL]
QUANDO o sistema sugerir saldo para picking ou transferência de saída, DEVE respeitar a política configurada do produto (`FEFO` padrão para itens com validade; `FIFO`, `LIFO` ou `JIT` conforme cadastro). Quebra de política exige permissão específica + workflow de aprovação + motivo + log (AD-007).

### RG-007 — Identificação por LPN [INVIOLÁVEL]
QUANDO um palete/volume for criado, o sistema DEVE gerar LPN único global e emitir etiqueta com QR Code e código de barras (DOC-11). Movimentações físicas de palete DEVEM ser confirmadas por leitura de LPN (ou digitação com permissão específica + log).

### RG-008 — Periféricos somente via Edge Agent [INVIOLÁVEL]
QUANDO o sistema precisar imprimir, pesar, acionar cancela/catraca ou consumir LPR, DEVE fazê-lo exclusivamente pelo protocolo do WMS Edge Agent (DOC-11). É PROIBIDO qualquer acesso direto do navegador a hardware.

### RG-009 — Idempotência de integrações e sincronização [INVIOLÁVEL]
QUANDO o sistema receber mensagem de integração (DOC-13) ou lote de sincronização offline (AD-005), DEVE processá-la de forma idempotente por chave de idempotência obrigatória. Reprocessamentos não podem duplicar efeitos.

### RG-010 — Datas, moeda e unidades
Timestamps persistidos em UTC (ISO 8601); exibição no fuso do armazém. Moeda: BRL com 2 casas decimais em exibição e 4 em cálculo tarifário (arredondamento half-even na consolidação). Quantidades de estoque: `NUMERIC(18,6)`. Pesos em kg com 3 casas. Dimensões em metros com 3 casas.

### RG-011 — Identificadores
Chaves primárias: UUID v7. Códigos legíveis por humanos (nº de pedido, LPN, ordem de recebimento) seguem máscaras definidas no DOC-02 e são sequenciais por armazém.

### RG-012 — Internacionalização
Interface nativa em pt-BR com arquitetura i18n preparada (chaves de tradução obrigatórias, sem strings literais em componentes). Nenhum outro idioma será entregue na versão 1.

### RG-013 — Acessibilidade e padrão visual
Interface clean e profissional: componentes padronizados (botões, tabelas, formulários) de biblioteca única definida no DOC-01, conjunto único de ícones (Lucide), contraste mínimo WCAG 2.1 AA, feedback visual imediato (< 100 ms) para toda ação do usuário.

### RG-014 — Controle de estoque fiscal por nota de armazenagem [INVIOLÁVEL]
O sistema DEVE manter, para produtos de Clientes, o Estoque Fiscal como dimensão de saldo paralela ao estoque físico, segregada por Nota de Armazenagem, obedecendo ao ciclo:

1. QUANDO a mercadoria chegar acompanhada de Nota Fiscal de Entrada, o sistema DEVE registrar a posse temporária, iniciar contagem do prazo-limite configurável para regularização e disponibilizar a nota ao Cliente (portal/integração) para emissão da Nota de Armazenagem.
2. QUANDO a Nota de Armazenagem do Cliente for recebida/registrada, o sistema DEVE vinculá-la à(s) Nota(s) Fiscal(is) de Entrada correspondente(s) e **creditar o Estoque Fiscal** nas quantidades da nota.
3. QUANDO houver picking de pedido de saída, o sistema DEVE gerar a Alocação Fiscal do item contra uma ou mais Notas de Armazenagem com saldo, e a Nota de Devolução de Armazenagem emitida DEVE citar, em cada item, o número da Nota de Armazenagem consumida, com a respectiva quantidade.
4. SE a quantidade a alocar de um item exceder o Estoque Fiscal disponível somado das Notas de Armazenagem do produto, ENTÃO o sistema DEVE rejeitar a emissão da Nota de Devolução de Armazenagem com erro determinístico, indicando o saldo fiscal disponível por nota. Não existe configuração, papel ou override que permita saldo fiscal negativo.
5. Um mesmo item de saída PODE consumir múltiplas Notas de Armazenagem (rateio em linhas distintas da nota de saída, uma referência por linha).

**Exemplo normativo (teste de referência):**
Estoque fiscal do produto X do cliente C: 1.000 unidades, composto por:
- Nota de Armazenagem 1000234 → 500 un
- Nota de Armazenagem 2356899 → 100 un
- Nota de Armazenagem 3216544 → 400 un

Pedido de saída de 700 un: a Nota de Devolução de Armazenagem DEVE conter três linhas do produto X — 500 un ref. 1000234, 100 un ref. 2356899 e 100 un ref. 3216544 (assumindo consumo por ordem de entrada; ordem definitiva de consumo definida no DOC-08). Saldos fiscais resultantes: 1000234 = 0; 2356899 = 0; 3216544 = 300. Pedido de saída de 1.001 un DEVE ser rejeitado na emissão fiscal.

O detalhamento de CFOPs, naturezas de operação, prazos legais e comportamento na expiração do prazo da Nota Fiscal de Entrada está no DOC-08.

### RG-015 — Contenção de movimentações no Armazém Lógico [INVIOLÁVEL]
ONDE existir Armazém Lógico ativo para um Cliente em um Armazém físico:

1. QUANDO o motor de putaway, uma transferência ou qualquer sugestão de endereçamento processar produto desse Cliente, o sistema DEVE restringir os endereços candidatos aos endereços vinculados ao Armazém Lógico do Cliente.
2. QUANDO qualquer operação tentar movimentar produto de OUTRO cliente para endereço vinculado a um Armazém Lógico, o sistema DEVE rejeitar a operação com erro determinístico. Esta exclusividade NÃO admite override por nenhum papel.
3. SE não houver endereço com capacidade disponível dentro do Armazém Lógico (transbordo), ENTÃO o sistema DEVE bloquear a operação e abrir exceção no Workflow de Aprovação (AD-007); somente aprovação com permissão `LOGICAL_WAREHOUSE_OVERFLOW` autoriza alocação temporária fora do Armazém Lógico, marcada como `TRANSBORDO`, com retorno obrigatório sugerido pelo sistema assim que houver capacidade.
4. Endereços PODEM ser vinculados/desvinculados do Armazém Lógico apenas quando estiverem com saldo zero, por usuário com permissão específica, com log (RG-003).
5. Consultas de saldo, inventários, painéis e faturamento DEVEM permitir filtro e visão consolidada por Armazém Lógico.
6. As demais regras globais (RG-004, RG-005, RG-006, RG-014) permanecem plenamente aplicáveis dentro do Armazém Lógico — a contenção soma-se a elas, não as substitui.

A ativação/desativação do Armazém Lógico é configuração do cadastro do Cliente × Armazém (DOC-02); a desativação exige Armazém Lógico sem saldo `TRANSBORDO` pendente e transfere a governança dos endereços de volta ao armazém físico.

---

## 7. CONVENÇÕES DE ESCRITA DE REQUISITOS (APLICÁVEIS AOS DOC-01 A DOC-13)

### 7.1 Identificação

```
Formato do ID:  <TIPO>-<MÓDULO>-<SEQ>
TIPO:   RF (funcional) | RN (regra de negócio) | RNF (não-funcional)
        | RI (integração) | RD (dado)
MÓDULO: ARQ, DAD, POR, REC, EST, EXP, REV, FIS, FAT, PAI, PER, SEG, INT
SEQ:    numeração de 3 dígitos, imutável, sem reuso após remoção
Exemplo: RF-EXP-014
```

### 7.2 Sintaxe EARS (obrigatória para requisitos funcionais)

| Padrão | Modelo |
|---|---|
| Ubíquo | O sistema DEVE \<comportamento\>. |
| Dirigido por evento | QUANDO \<gatilho\>, o sistema DEVE \<comportamento\>. |
| Dirigido por estado | ENQUANTO \<estado\>, o sistema DEVE \<comportamento\>. |
| Comportamento indesejado | SE \<condição de falha\>, ENTÃO o sistema DEVE \<resposta\>. |
| Opcional/configurável | ONDE \<configuração ativa\>, o sistema DEVE \<comportamento\>. |

Palavras normativas: DEVE (obrigatório), NÃO PODE/É PROIBIDO (proibição), PODE (permitido). É proibido usar "deveria", "idealmente", "se possível".

### 7.3 Critérios de aceite (obrigatórios para toda regra condicional)

Formato Gherkin em pt-BR:

```gherkin
Cenário: <nome determinístico>
  Dado <estado inicial com valores concretos>
  Quando <ação com valores concretos>
  Então <resultado verificável com valores concretos>
```

### 7.4 Máquinas de estado (obrigatórias para todo Fluxo Operacional)

Notação Mermaid `stateDiagram-v2`, com tabela de transições (estado origem, evento, guarda, estado destino, efeitos colaterais). Estados não presentes no diagrama NÃO existem.

### 7.5 Cálculos

Todo requisito com cálculo (tarifa, FEFO, cubagem, peso) DEVE conter no mínimo 1 exemplo numérico completo com entrada, passos e resultado esperado, que servirá de teste de referência.

### 7.6 Seções obrigatórias de cada documento-módulo

```
1. Escopo e objetivo
2. Dependências e termos usados (referência ao §4 do DOC-00)
3. Atores e permissões envolvidas
4. Requisitos funcionais (RF) e regras de negócio (RN)
5. Máquinas de estado e fluxos
6. Critérios de aceite (Gherkin)
7. Requisitos de dados (RD) — delta sobre o DOC-02
8. FORA DE ESCOPO (lista explícita do que NÃO implementar)
9. Matriz de rastreabilidade local
```

---

## 8. MATRIZ DE RASTREABILIDADE (NÍVEL MACRO)

Mapeamento das necessidades originais do cliente para os documentos-módulo. Cada módulo detalhará sua matriz local (requisito → tela → API → tabela → teste).

| # | Necessidade original | Documento(s) |
|---|---|---|
| N01 | Portaria: entrada/saída de pessoas, veículos e cargas | DOC-03 |
| N02 | Pátio de espera para carga e descarga | DOC-03 |
| N03 | Docas: carga/descarga, conferência, divergências, alocação por categoria/espécie/lote | DOC-04 |
| N04 | Cross-docking | DOC-04 |
| N05 | Logística reversa | DOC-07 |
| N06 | Inventários (produto, dia, sorteio, zona, espécie) | DOC-05 |
| N07 | Estruturas de armazenagem (porta-paletes, drive-in, drive-thru, cantilever, flowrack, estantes, gavetas, carrossel) | DOC-02, DOC-05 |
| N08 | Espaços e segregação por espécie (medicamentos, inflamáveis, combustível) | DOC-02, DOC-05 |
| N09 | Pedidos, picking, packing, pesagem | DOC-06 |
| N10 | Etiquetas QR Code + código de barras para paletes | DOC-11 |
| N11 | Estoques próprios e de terceiros; vencimento; FIFO/FEFO/LIFO; shelf life; JIT; transferência | DOC-05 |
| N12 | Estoque de segurança | DOC-05 |
| N13 | Kanban | DOC-05 |
| N14 | Multi-armazéns e multi-empresas | DOC-01, DOC-02, DOC-12 |
| N15 | APIs de integração com ERP (entrada e saída) | DOC-13 |
| N16 | Painel de controle com gráficos de performance diária | DOC-10 |
| N17 | Painel de Operações Pendentes com fluxo verde/vermelho sem salto de etapas | DOC-06, DOC-10 (regra global RG-002) |
| N18 | Logs de operação detalhados e robustos | DOC-12 (regra global RG-003) |
| N19 | Execução em qualquer navegador | DOC-01 |
| N20 | Comunicação com impressoras e periféricos de rede local | DOC-11 (regra global RG-008) |
| N21 | Visual clean, botões padronizados, ícones modernos | DOC-01 (regra global RG-013) |
| N22 | Faturamento de serviços de armazenagem | DOC-09 |
| N23 | Alta concorrência (4.000 usuários, 50k pedidos/dia) | DOC-01 |
| N24 | Tempo real (painel, chat, rastreamento) | DOC-01, DOC-10 |
| N25 | Emissão fiscal opcional por cliente | DOC-08 |
| N26 | Operação em coletores/tablets com offline | DOC-01 |
| N27 | Estoque fiscal por nota de armazenagem: entrada com NF do cliente, nota de armazenagem, nota de devolução com referência por item, bloqueio de saldo fiscal insuficiente | DOC-08 (regra global RG-014), DOC-05, DOC-06 |
| N28 | Armazém lógico dedicado por cliente com direcionamento de todas as movimentações | DOC-02, DOC-05 (regra global RG-015) |
| N29 | Operação em armazém próprio (não-3PL) com a mesma base de código | DOC-00 §3.1 (regra global RG-016), DOC-02 (parâmetro e validação) |

**Regra de completude:** ao final da elaboração dos 13 módulos, toda linha N01–N26 deve estar coberta por pelo menos um requisito com ID. Linha sem cobertura = especificação incompleta.

---

## 9. CONTROLE DE VERSÕES E LACUNAS

### 9.1 Versionamento
Todos os documentos seguem SemVer (`MAJOR.MINOR.PATCH`). Alteração de requisito existente = MAJOR do documento; adição = MINOR; correção editorial = PATCH. Todo documento carrega changelog no rodapé.

### 9.2 Registro de lacunas (situação final)

| ID | Lacuna | Situação |
|---|---|---|
| LAC-001 | Protocolos de balanças | ✅ RESOLVIDA — DOC-11 RNF-PER-040 (Toledo P05, Filizola CS, parser genérico; modelos físicos = configuração de implantação) |
| LAC-002 | Layout das etiquetas | ✅ RESOLVIDA — DOC-11 RN-PER-010/RN-PER-020 (GS1, 5 templates ZPL padrão) |
| LAC-003 | Matriz de compatibilidade entre espécies | ✅ RESOLVIDA — DOC-05 RN-EST-020..022 (validar com compliance) |
| LAC-004 | KPIs e fórmulas do dashboard | ✅ RESOLVIDA — DOC-10 RN-PAI-041 (17 KPIs) |
| LAC-005 | Máscara de numeração de documentos | ✅ RESOLVIDA — DOC-02 RN-DAD-040 |
| LAC-006 | Particionamento de logs e saldos | ✅ RESOLVIDA — DOC-01 RNF-ARQ-090..092 |
| LAC-007 | Prazo da NF de entrada e expiração | ✅ RESOLVIDA — DOC-08 RN-FIS-010 **[VALIDAR CONTABILIDADE]** |
| LAC-008 | Ordem de consumo do Estoque Fiscal | ✅ RESOLVIDA — DOC-08 RN-FIS-030 **[VALIDAR CONTABILIDADE]** |
| LAC-009 | CFOPs e naturezas de operação | ✅ RESOLVIDA — DOC-08 RN-FIS-050 **[VALIDAR CONTABILIDADE]** |

**Verificação de completude (regra do §8):** todas as necessidades N01–N28 possuem cobertura por requisitos identificados nas matrizes locais dos DOC-01 a DOC-13. A especificação está COMPLETA para geração, condicionada à homologação contábil dos três itens marcados.

---

## CHANGELOG

| Versão | Data | Alteração |
|---|---|---|
| 1.0.0 | 2026-08-10 | Versão inicial aprovada |
| 1.1.0 | 2026-08-10 | Adição do controle de Estoque Fiscal: glossário §4.7, regra global RG-014, necessidade N27, lacunas LAC-007 a LAC-009 |
| 1.2.0 | 2026-08-10 | Adição do Armazém Lógico: termo no glossário §4.2, regra global RG-015, necessidade N28 |
| 1.3.0 | 2026-08-10 | Encerramento: LAC-001 a LAC-009 resolvidas nos módulos; verificação de completude N01–N28 |
| 1.4.0 | 2026-08-16 | Modos de operação: nova §3.1, regra global RG-016, termo no glossário §4.2, necessidade N29 |
