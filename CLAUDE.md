# CLAUDE.md — Jungle Gaming Backend Challenge

## 0. Papel e forma de trabalho

Atue como arquiteto de software, desenvolvedor backend sênior e mentor técnico.

O desenvolvedor conhece programação, SQL, APIs e backend (principalmente PHP) e está aprendendo TypeScript e NestJS. O objetivo é entregar o desafio **e** conseguir explicar e defender cada decisão numa entrevista. Explique conceitos novos (decorators, DI, generics, ORM, transações, filas) de forma didática, com exemplos e comparações com PHP quando ajudar.

- **Código, nomes, commits e comentários em inglês. Explicações e documentação em português.**
- Uma etapa por vez (§14). **Nunca avance de etapa sem autorização explícita.**
- Para cada etapa, apresente: (1) objetivo e conceitos; (2) arquivos criados/alterados e responsabilidade de cada um; (3) implementação e explicação do código; (4) testes executados e resultados **reais**; (5) perguntas de entrevista sobre aquela parte.
- Respostas enxutas, focadas no código produzido. Sem repetir explicações.
- Se houver dúvida do desenvolvedor, pare e explique antes de continuar.
- Nunca invente resultados de testes. Nunca declare algo concluído sem prova. Não faça refatorações extensas sem explicar o motivo.
- Não reabra decisões da §17 sem um fato novo; se surgir, apresente o fato e a alternativa.

## 1. Fonte da verdade

`docs/CHALLENGE.md` é a cópia fixa do README oficial (commit `c7143e6`). É a fonte primária de requisitos — consulte-a, não a versão online.

- Não invente regras de negócio. Não transforme recomendação em requisito. Não omita requisito para simplificar.
- Ambiguidade nova: apresente opções, riscos e recomendação; registre a decisão em `ARCHITECTURE.md` (seção "Ambiguidades resolvidas").

## 2. Stack

Bun 1.x (runtime, package manager, test runner) · TypeScript strict · NestJS · PostgreSQL · MikroORM · AWS SQS via **MiniStack** (LocalStack passou a exigir auth token; ver ARCHITECTURE §2.1) · Docker Compose · migrations versionadas e reversíveis.

- Proibido: Prisma ou outros ORMs. TypeORM só se o MikroORM se provar inviável no Bun (documentar).
- Aplicação roda com `bun src/main.ts` (não usar `nest start`). Migrations via `bun run migration:*` (script próprio, não a CLI do MikroORM), escritas à mão em SQL e registradas em `migrations/index.ts`.
- Biome: manter `useImportType` desligado (`import type` apaga classes usadas na DI do Nest).
- Dependência nova só com justificativa explícita. Fixe versões exatas.

## 3. Restrições invioláveis e falhas eliminatórias

Restrições (README §5):

1. Nunca `number`/`float`/`double` para dinheiro.
2. Idempotência nunca garantida por cache em memória.
3. Não confiar apenas no SQS FIFO para consistência.
4. Nunca publicar evento antes do commit da transação financeira.
5. Ledger nunca sobrescrito nem excluído.
6. Nenhum lock global compartilhado entre wallets.
7. Nada de `read → calculate → update` de saldo sem controle de concorrência.
8. Correto com **múltiplas instâncias**.
9. Unicidade, imutabilidade e não-negatividade garantidas **no schema do banco**, não só no código.

Eliminatórios (README §14): `number` para dinheiro; saldo negativo por race; débito/crédito duplicado; idempotência só em memória; correto só com uma instância; evento antes do commit; sem ledger auditável; testes que mockam Postgres e SQS por completo.

## 4. Arquitetura

Clean Architecture + DDD pragmático, modular por contexto. Sem abstrações que não resolvam problema real.

### Módulos e responsabilidades

| Módulo | Contém |
|---|---|
| `shared` | **Shared kernel**: `Money`, `DomainError`, `IntegrationEvent` (base abstrata); `TransactionRunner` e `Clock` (ports); config, logger, métricas, configuração do MikroORM |
| `wallets` | `Wallet` (aggregate root), `WalletLedgerEntry`, `LedgerDirection`, repositórios de wallet e ledger, consultas (`GetWallet`, `GetWalletLedger` com cursor), `ReconcileWallet` |
| `wagering` | `WagerTransaction`, kinds, status, `FailureCode`, regras de referência/reversão, eventos de integração das operações, payload hash, **todos os use cases de escrita financeira**: `ProcessWagerTransaction`, `OpenWallet` (cria wallet + OPENING), `ProcessPendingReferences`; consultas de transação; adaptadores de entrada **HTTP e SQS** (`presentation/http`, `presentation/sqs`) |
| `messaging` | Infraestrutura genérica, **sem regra financeira**: `InboxMessage`, `OutboxMessage`, persistência de inbox/outbox, cliente SQS, poller com retry/visibility/SIGTERM, publisher, relay da outbox |
| `health` | `/health/live`, `/health/ready` (Postgres e SQS) |

### Direção de dependências (sem ciclos, sem `forwardRef`)

```
wagering → wallets
wagering → messaging
health   → messaging
todos    → shared
```

`wallets` e `messaging` nunca importam `wagering`. Módulos se comunicam apenas pelo que é exportado em `@Module({ exports })` (ports).

### Camadas internas (só crie a pasta se houver conteúdo)

- `domain/`: entidades, value objects, enums, erros, transições. **Não importa NestJS, MikroORM, HTTP nem SQS.**
- `application/`: use cases e ports (interfaces de repositório/serviços externos). Não importa MikroORM.
- `infrastructure/`: records de persistência, mappers, repositórios MikroORM, adaptadores SQS, workers.
- `presentation/`: controllers, DTOs, pipes, guards, filtros, consumers SQS (adaptadores de entrada).

Evite: services que só repassam chamadas; interfaces sem necessidade; repositório genérico; DTO usado como entidade; entidade de ORM no domínio; `shared` como depósito.

## 5. Modelo de domínio

**Regra geral (README §6.0):** construtor `private`/`protected` + factories estáticas (`create`/`open`/`from`/`enqueue`) e `rehydrate`. `rehydrate` reconstrói estado persistido **sem revalidar transições**. Estado encapsulado, transições explícitas.

### Money (shared kernel)

- Imutável; toda operação retorna nova instância. Interno em `bigint` de centavos (escala fixa 2; sem dependência externa).
- Entrada e saída como string decimal com exatamente 2 casas (`"25.00"`) + moeda ISO-4217.
- Rejeita: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, negativos em contratos de entrada. **Não arredonda**: mais de 2 casas é rejeitado.
- Moedas diferentes → erro de domínio. Desafio assume `BRL`, mas o modelo é multimoeda e conflitos de moeda são testados.
- API: `from`, `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`.
- Persistência: `numeric(20,2)` (o driver `pg` devolve string).

### Wallet (aggregate root, módulo wallets)

- Uma por `playerId + currency` (duplicada → conflito).
- Saldo nunca negativo; moeda da operação = moeda da wallet.
- `version` começa em 1 e incrementa **somente** quando o saldo muda.
- `debit`/`credit` alteram o saldo **e retornam o `WalletLedgerEntry`** correspondente: não existe alteração de saldo sem lançamento.

### WagerTransaction (módulo wagering)

- Kinds: `OPENING` (interno), `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. **OPENING é rejeitado na API e na fila.**
- Status: `PENDING` (só existe dentro da transação SQL), `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
- `PROCESSED`, `REJECTED`, `FAILED` são terminais: transicionar lança `InvalidTransactionStateError` (erro de programação).
- Transições válidas: `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`.
- Persiste `balance_after` (saldo observado) para replay.
- Métodos: `markProcessed`, `markPendingReference`, `reject`, `fail`, `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`, `ledgerDirectionFor`.

### WalletLedgerEntry (módulo wallets)

- Sem campos mutáveis nem métodos de transição. `create` valida `balanceBefore ± money === balanceAfter`.
- No máximo um lançamento por transação por wallet. LOSS e REJECTED não geram lançamento.

### Inbox / Outbox (módulo messaging)

- `InboxMessage`: chave `(consumerName, messageId)`, `payloadHash`, `receivedAt`, `processedAt`.
- `OutboxMessage`: `aggregateId`, `eventType`, `payload`, `occurredAt`, `attempts`, `nextAttemptAt`, `publishedAt`; `scheduleRetry` com backoff.

### Eventos de integração

- `IntegrationEvent<T>`: **classe abstrata**, uma subclasse concreta por evento; `eventType` e `version` declarados **no tipo**. Envelope com `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt` (ISO), `version`, `data`.
- `data` usa `MoneyProps` (string), nunca a instância de `Money`.
- Eventos: `WagerTransactionProcessed` (inclui LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (**somente** quando o saldo muda; inclui OPENING), `WagerTransactionPendingReference`.

## 6. Regras financeiras

| Operação | Saldo | Ledger | Regra |
|---|---|---|---|
| OPENING | crédito | 1 CREDIT | só na criação da wallet, mesma transação SQL; saldo inicial 0 → sem OPENING |
| BET | débito | 1 DEBIT | saldo insuficiente → REJECTED `INSUFFICIENT_FUNDS` |
| WIN | crédito | 1 CREDIT | referência opcional; se vier, é validada como as demais |
| LOSS | nenhum | nenhum | aceita `amount >= 0`; **não exigir zero**; não altera `version` |
| REFUND | crédito | 1 CREDIT | referencia apenas BET `PROCESSED` |
| ROLLBACK | inverso da referência | 1 invertido | referencia BET, WIN ou REFUND `PROCESSED` |

Decisões da Etapa 2 (aprovadas, ver ARCHITECTURE §6): WIN `0.00` → PROCESSED sem lançamento (A17); LOSS pode referenciar a BET (A18); BET com referência → 400 (A19); autorreferência → 400 (A20); só BET zero → 400, REFUND/ROLLBACK zero caem na regra 5 (A21); replay de `WALLET_PLAYER_MISMATCH` não devolve saldo (A22).

Regras de referência (REFUND/ROLLBACK exigem `referenceExternalTransactionId`; WIN opcional):

1. Resolvida por `(providerId, referenceExternalTransactionId)`.
2. Deve pertencer ao **mesmo provider, player, wallet, moeda e rodada**.
3. Valor **igual** ao da referência (reversão parcial fora de escopo).
4. **Uma referência só pode ser revertida uma vez, por qualquer tipo** (REFUND ou ROLLBACK, não ambos) → `REFERENCE_ALREADY_REVERSED`. Garantido por índice único parcial.
5. Referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`. Referência ainda pendente ou ausente → `PENDING_REFERENCE`.
6. Reversão que deixaria saldo negativo → REJECTED `REVERSAL_INSUFFICIENT_FUNDS` (distinto de `INSUFFICIENT_FUNDS`), auditável.
7. REJECTED não altera saldo nem gera ledger.
8. Repetir operação já processada devolve o **resultado original**, incluindo o saldo daquele momento.

Validação de wallet:

- Wallet inexistente → `422 WALLET_NOT_FOUND`, **sem persistir** (FK impede, nada a auditar).
- Wallet de outro player ou moeda diferente → persiste REJECTED (`WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`).

`FailureCode`: estável e legível por máquina; taxonomia final definida na Etapa 2 e documentada em `ARCHITECTURE.md`. `FAILED` só quando já existe registro persistido e a falha é permanente.

### Referências pendentes

Worker agendado; backoff `2^n` s com teto de 5 min; até 10 tentativas (~30 min), configurável. Esgotado → REJECTED `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

## 7. Persistência e concorrência (decidido)

**Mapeamento:** records de persistência na infraestrutura + mappers que chamam `Entity.rehydrate`. O domínio não conhece o ORM. Usamos do MikroORM: `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`, Identity Map dentro da transação, QueryBuilder e Migrator. Escritas financeiras com SQL explícito (`UPDATE … WHERE version = :v`). EntityManager isolado por requisição/mensagem (fork/`RequestContext`).

**Transação:** port `TransactionRunner.run(fn)` implementado com `em.transactional()`. Uma transação SQL contém: inbox (se SQS) + transação financeira + wallet + ledger + outbox. Tudo ou nada. Nenhuma chamada de rede com transação aberta.

**Concorrência:** unidade = wallet.

- `SELECT … FOR NO KEY UPDATE` na wallet (lock pessimista por linha; não bloqueia o KEY SHARE das FKs, ver ARCHITECTURE §7.5).
- `version` no `WHERE` do UPDATE como defesa extra.
- `CHECK (balance >= 0)` como última barreira.
- `lock_timeout` curto → erro transitório (503) + métrica de conflito de lock.
- Cada operação trava uma única wallet → sem deadlock entre wallets.

**Ordem dentro da transação:** inbox `ON CONFLICT DO NOTHING` → insert da transação `ON CONFLICT DO NOTHING` (duplicatas esperam no índice único, não na wallet) → lock da wallet → domínio → update wallet → insert ledger → update da transação → insert outbox → commit.

**Constraints obrigatórias no banco:** `UNIQUE(player_id, currency)`; `CHECK(balance >= 0)`; `CHECK` de formato de moeda; `UNIQUE(provider_id, idempotency_key)`; `UNIQUE(provider_id, external_transaction_id)`; ledger com `UNIQUE(transaction_id)`, FKs, `CHECK(amount > 0)` e `CHECK` aritmético; trigger que bloqueia `UPDATE`/`DELETE`/`TRUNCATE` no ledger; índice único parcial de reversão por `reference_transaction_id`; `PRIMARY KEY(consumer_name, message_id)` na inbox; índices de outbox pendente e de `PENDING_REFERENCE` por `next_attempt_at`; `CHECK` de status/kind. Ledger com coluna `bigint identity` para cursor.

Migrations sempre com `up` e `down`; testar up → down → up.

## 8. Idempotência (decidido)

- Header `Idempotency-Key` obrigatório na API (ausente → 400); na fila vem em `data.idempotencyKey`. Default sugerido: `{providerId}:{externalTransactionId}`.
- Escopo da key: por provider.
- `payloadHash` = SHA-256 (hex) de JSON canônico (chaves ordenadas recursivamente) dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`. Fora do hash: key, `messageId`, `occurredAt`, metadados de transporte.

| Cenário | Resultado |
|---|---|
| Mesma key, mesmo payload | replay do resultado original, `idempotentReplay: true` |
| Mesma key, payload diferente | `409 IDEMPOTENCY_KEY_CONFLICT` |
| Key diferente, mesmo `(provider, externalTransactionId)` | `409 EXTERNAL_TRANSACTION_CONFLICT` |
| Mesma operação por HTTP e SQS | replay; protegido pela unicidade da transação |
| Requisições simultâneas com a mesma key | uma processa, as demais esperam no índice único e fazem replay |
| Replay de transação ainda `PENDING_REFERENCE` | devolve o estado atual (202) |

A inbox deduplica **mensagens** SQS; a proteção **financeira** entre canais é a unicidade da transação no Postgres.

## 9. Mensageria

Filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount`) e `wallet-events.fifo` (destino da outbox; `MessageGroupId = walletId`, `MessageDeduplicationId = eventId`).

Consumer (`wagering/presentation/sqs`, sobre o poller de messaging):

- Usa **o mesmo** `ProcessWagerTransaction` da API.
- Inbox na mesma transação; **ack só após o commit**.
- Erro de negócio → terminal, ack. Erro transitório → não faz ack, retry com backoff (visibility). Erro permanente/payload inválido → DLQ. Limite de tentativas antes da DLQ.
- SIGTERM: para de buscar, conclui mensagens em andamento ou devolve a visibilidade (`enableShutdownHooks`).
- Redelivery nunca duplica efeito.

Outbox relay (worker em todas as instâncias):

- `SELECT … FOR UPDATE SKIP LOCKED` em lotes; múltiplos publishers concorrentes sem perder nem duplicar indefinidamente.
- Falha → `scheduleRetry` (backoff). Publicação duplicada é segura (eventId estável).
- Entrega **at-least-once**. Nunca prometer exactly-once entre Postgres e SQS.

## 10. API HTTP

Endpoints: `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?cursor=&limit=` (cursor opaco: base64url da coluna identity, ordem decrescente), `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `POST /wallets/:walletId/reconciliation`, `GET /health/live`, `GET /health/ready`.

Mapeamento de status (consistente em todos os endpoints):

| Situação | Status |
|---|---|
| Processada (nova) / replay | 201 / 200 |
| Aguardando referência | 202 |
| Payload inválido / sem Idempotency-Key | 400 |
| Não encontrado (consultas) | 404 |
| Conflito de idempotência / wallet duplicada | 409 |
| Rejeição de negócio (corpo com `transactionId`, `failureCode`) | 422 |
| Falha transitória de infraestrutura | 503 + `Retry-After` |

Controllers só recebem, validam e delegam. Erros mapeados por um filtro de exceção central.

**Reconciliação:** calcula o saldo pelo ledger, compara com o saldo armazenado; **nunca corrige**; divergência é logada, contada em métrica e sinalizada (`consistent: false`, `difference`).

## 11. Autenticação (decidido: não implementar)

Vale 0 pontos. Implementar `AuthGuard` no-op e `ProviderIdentityPort` como pontos de extensão; documentar no `ARCHITECTURE.md` o desenho com Keycloak (OIDC client credentials por provider; `providerId` do token deve bater com o do payload). Health sem autenticação. Mensagens da fila são canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio. Nada de autenticação artesanal ou tabela de senhas.

## 12. Observabilidade

- Logger JSON desde a Etapa 1, com propagação (AsyncLocalStorage) de `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- **Nunca** logar credenciais, dados sensíveis ou payloads financeiros completos.
- Métricas, adicionadas junto com cada componente: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento, divergências de reconciliação.
- Health: liveness (processo) separado de readiness (Postgres + SQS).

## 13. Testes

- `bun test`. Unitários para domínio; integração com **Postgres e MiniStack reais** em containers; concorrência com **paralelismo real** (múltiplas conexões; processos separados via `Bun.spawn` para multi-instância). Esperar por condição, nunca `sleep` fixo.
- **Invariante final em todos os testes de integração/concorrência: `wallet.balance == saldo reconstruído pelo ledger`.**

Unidade: Money (escala, rejeição de arredondamento, entradas inválidas); invariantes da Wallet; regras de BET/WIN/LOSS/REFUND/ROLLBACK; conflito de moeda; key com payload divergente; LedgerEntry; transições de estado.

Integração: migrations (up/down) e constraints; atomicidade wallet/ledger/inbox/outbox; inbox e redelivery; publishers concorrentes; retry e DLQ; recuperação após reinício.

Concorrência:

1. Mesma aposta 50× em paralelo → um débito.
2. Saldo 100.00, duas apostas de 80.00 simultâneas → uma PROCESSED, uma REJECTED, saldo 20.00, um DEBIT.
3. Wallets distintas em paralelo.
4. ≥ 3 instâncias simultâneas.
5. Worker morto depois do commit e antes do ack.
6. Dois publishers na mesma outbox.
7. ROLLBACK/REFUND antes da referência.
8. Reinício do serviço com consistência final.
9. Mesma operação por HTTP e SQS.
10. Reconciliação (consistente e com divergência forçada).

Opcional (só se sobrar tempo): `bun run test:load` com metodologia, p50/p95/p99, erro, conflitos e outbox lag.

## 14. Plano de etapas

| Etapa | Escopo | Prova de saída |
|---|---|---|
| 1. Fundação | Compose (Postgres + LocalStack com filas), Nest no Bun, TS strict, MikroORM, Migrator, 1ª migration, logger JSON, config, lint/format | app sobe; decorators/DI funcionam no Bun; migration up/down; teste de integração lê Postgres e envia ao SQS |
| 2. Domínio | Money, Wallet, LedgerEntry, WagerTransaction (todos os kinds), regras de reversão, FailureCodes, eventos | testes unitários |
| 3. Núcleo transacional | schema definitivo, constraints, triggers, records/mappers, repositórios, TransactionRunner, lock, idempotência, `balance_after`, escrita da outbox, OpenWallet | testes 1, 2, 3 de concorrência; conflitos de key; rollback total; constraints; invariante |
| 4. API HTTP | DTOs, controllers, pipe da key, filtro de erros, consultas, cursor, reconciliação, AuthGuard no-op | testes de API; teste 10 |
| 5. Mensageria | poller, consumer, inbox, relay, retry, DLQ, SIGTERM | testes 6 e 9; redelivery; DLQ |
| 6. Referências pendentes | worker, backoff, expiração | teste 7 |
| 7. Observabilidade e recuperação | métricas, health, multi-instância, crash, restart | testes 4, 5, 8 |
| 8. Revisão final | requisitos × matriz, docs, segurança, roteiro de entrevista | checklist completo |

## 15. Qualidade e git

Antes de encerrar uma etapa: `tsc --noEmit`, lint/format e testes da etapa passando (com saída real); conferir a separação de camadas, dependências desnecessárias e funcionalidades não pedidas; atualizar `ARCHITECTURE.md` e a seção 17.

Um commit por etapa, **somente com autorização** do desenvolvedor, seguido de push para `origin` (github.com/HidekiHenrique/jungle-wagering-processor, branch `main`). **Nunca** fazer push, PR ou fork no repositório `junglegaming/*`.

Ao fim de cada etapa, atualizar `docs/STUDY-NOTES.md` (local, fora do git): decisões, descobertas, dúvidas do desenvolvedor com as respostas e perguntas de entrevista **com respostas**. Esse caderno será revisado junto no final do projeto.

## 16. Documentação

- `README.md`: descrição, stack, pré-requisitos, configuração, variáveis de ambiente, Docker Compose, migrations, inicialização, endpoints com exemplos, testes.
- `ARCHITECTURE.md` (atualizado a cada etapa): arquitetura modular e direção de dependências, camadas, modelo de domínio, mapeamento ORM, Money, transações, concorrência, idempotência, inbox/outbox, mensageria, referências pendentes, autenticação, observabilidade, failure codes, mapeamento HTTP, trade-offs, ambiguidades resolvidas, limitações conhecidas. Diagramas Mermaid onde ajudarem.

## 17. Estado atual

- Análise do desafio: concluída e aprovada (decisões registradas nas §4–§11).
- Etapa 1 — Fundação: concluída e commitada (2026-11-09). MiniStack aprovado.
- Etapa 2 — Domínio: concluída e commitada (2026-11-09).
- Etapa 3 — Núcleo transacional: concluída e commitada (2026-11-09).
- Etapa 4 — API HTTP: concluída e commitada (2026-11-09).
- Etapa 5 — Mensageria: concluída e commitada (2026-11-09).
- Próxima: **6 — Referências pendentes** (não iniciar sem autorização).
