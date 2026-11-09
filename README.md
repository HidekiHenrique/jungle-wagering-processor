# Distributed Wagering Processor

Solução do [desafio backend da Jungle Gaming](docs/CHALLENGE.md): serviço financeiro que processa transações de apostas de múltiplos provedores com correção sob duplicação, desordem e concorrência entre instâncias.

Decisões técnicas: [ARCHITECTURE.md](ARCHITECTURE.md).

## Destaques

- **Dinheiro exato**: `Money` em `bigint` de centavos, sem `number` em lugar nenhum; entradas fora do contrato são rejeitadas, nunca arredondadas.
- **Garantias no banco**: unicidade, não-negatividade, imutabilidade do ledger e aritmética dos lançamentos são constraints e triggers do PostgreSQL.
- **Concorrência**: lock por wallet (`FOR NO KEY UPDATE`), `version` e `CHECK`; nenhum lock global; correto com N instâncias.
- **Idempotência persistente**: `Idempotency-Key` + hash SHA-256 de JSON canônico; replay devolve o resultado original; HTTP e SQS compartilham o mesmo use case.
- **Mensageria resiliente**: inbox, transactional outbox com `SKIP LOCKED`, retry com backoff, DLQ, shutdown gracioso.
- **Referências fora de ordem**: `PENDING_REFERENCE` com worker, backoff e rejeição explícita.
- **Provado por testes reais**: 157 unitários, 93 de integração (Postgres + SQS em containers, sem mocks de infraestrutura) e 4 cenários com processos reais (3 instâncias, `kill -9`, reinício).

## Início rápido

```bash
bun install
cp .env.example .env
bun run infra:up          # Postgres + MiniStack + filas
bun run migration:up
bun run start             # http://localhost:3000
bun run test:all          # unitários + integração + distribuídos
```

## Stack

Bun 1.4 · TypeScript 7 (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 18 · SQS (MiniStack) · Docker Compose · Biome

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.4
- Docker com Compose v2+

## Configuração

```bash
bun install
cp .env.example .env      # valores padrão já funcionam com o docker-compose
```

| Variável | Padrão | Descrição |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` ou `production` |
| `HTTP_PORT` | `3000` | porta da API |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `verbose` |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | PostgreSQL |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `wagering` | credenciais e banco |
| `DB_POOL_MAX` | `10` | conexões máximas por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock de uma wallet (depois: erro transitório) |
| `PENDING_REFERENCE_BASE_DELAY_MS` | `2000` | primeiro intervalo de reprocessamento de referência ausente |
| `PENDING_REFERENCE_MAX_DELAY_MS` | `300000` | teto do backoff |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `10` | tentativas antes de `REFERENCE_NOT_FOUND` |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint SQS (MiniStack local) |
| `SQS_REGION` | `us-east-1` | região |
| `SQS_ACCESS_KEY_ID` / `SQS_SECRET_ACCESS_KEY` | `test` | credenciais (fictícias no emulador) |
| `SQS_WAGER_QUEUE` | `wager-transactions.fifo` | fila de entrada |
| `SQS_WAGER_DLQ` | `wager-transactions-dlq.fifo` | dead letter queue |
| `SQS_EVENTS_QUEUE` | `wallet-events.fifo` | destino dos eventos da outbox |

Opcionais (com padrão): `SQS_WAIT_TIME_SECONDS` (10), `SQS_RETRY_BASE_DELAY_SECONDS` (1), `SQS_RETRY_MAX_DELAY_SECONDS` (60), `SQS_CONSUMER_ENABLED` (true), `OUTBOX_RELAY_ENABLED` (true), `OUTBOX_POLL_INTERVAL_MS` (500), `OUTBOX_BATCH_SIZE` (50), `PENDING_REFERENCE_WORKER_ENABLED` (true), `PENDING_REFERENCE_POLL_INTERVAL_MS` (1000), `PENDING_REFERENCE_BATCH_SIZE` (50), `SHUTDOWN_TIMEOUT_MS` (20000, deve ser maior que o long poll).

Testes usam `.env.test`: banco `wagering_test` e workers desligados (cada teste de mensageria cria filas próprias e liga o que precisa).

## Infraestrutura

```bash
bun run infra:up      # Postgres + MiniStack + criação das filas
bun run infra:down    # para os containers (dados preservados)
docker compose down -v  # remove também os volumes
```

## Migrations

```bash
bun run migration:status
bun run migration:up      # aplica as pendentes
bun run migration:down    # reverte a última
```

## Executar

```bash
bun run start   # ou: bun run dev (reload ao salvar)
```

Logs saem em JSON, uma linha por evento. Toda resposta HTTP traz `X-Correlation-Id`.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial > 0 gera transação OPENING) |
| `GET` | `/wallets/:walletId` | consulta wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | lançamentos, mais recentes primeiro (cursor opaco) |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo com o ledger (nunca corrige) |
| `POST` | `/wagering/transactions` | submete BET/WIN/LOSS/REFUND/ROLLBACK (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (Postgres + SQS); sem autenticação |
| `GET` | `/metrics` | métricas Prometheus |

Status por resultado: 201 aplicada · 200 replay · 202 aguardando referência · 400 inválida · 404 inexistente · 409 conflito de idempotência · 422 rejeição de negócio (`failureCode`) · 503 transitório (`Retry-After`, reenviar). Detalhes em [ARCHITECTURE.md §8](ARCHITECTURE.md).

### Exemplos

```bash
# criar wallet
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# → 201 {"id":"…","playerId":"…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# apostar (reenviar a mesma requisição devolve 200 com "idempotentReplay": true)
curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<playerId>",
       "walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

# mesma operação pela fila (o consumer roda dentro da aplicação)
bun scripts/send-wager-message.ts <walletId> <playerId> BET 30.00

# ledger e reconciliação
curl 'localhost:3000/wallets/<walletId>/ledger?limit=50'
curl -X POST localhost:3000/wallets/<walletId>/reconciliation
```

## Estrutura

```
src/
  shared/            shared kernel (Money, eventos, ports) e infraestrutura comum (config, logs, banco, métricas)
  modules/
    wallets/         Wallet, ledger, consultas, reconciliação
    wagering/        WagerTransaction, regras de liquidação, use cases de escrita, HTTP e consumer SQS
    messaging/       inbox, outbox, poller SQS, relay (sem regra financeira)
    health/          liveness, readiness, /metrics
  presentation/      filtro de erros e pipeline HTTP (raiz de composição)
migrations/          SQL versionado e reversível
test/unit|integration|distributed
```

## Testes e qualidade

```bash
bun run test              # unitários
bun run test:integration  # integração com Postgres e SQS reais (requer infra:up)
bun run test:distributed  # 3+ processos reais, kill -9 e reinício (requer infra:up)
bun run test:all          # tudo
bun run typecheck         # tsc --noEmit
bun run lint              # biome
bun run format            # biome com correções
bun run check             # typecheck + lint + unitários
```
