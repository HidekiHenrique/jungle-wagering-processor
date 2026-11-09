# Distributed Wagering Processor

Solução do [desafio backend da Jungle Gaming](docs/CHALLENGE.md): serviço financeiro que processa transações de apostas de múltiplos provedores com correção sob duplicação, desordem e concorrência entre instâncias.

Decisões técnicas: [ARCHITECTURE.md](ARCHITECTURE.md).

> Em desenvolvimento por etapas. Concluídas: **1 — Fundação**, **2 — Domínio**, **3 — Núcleo transacional**.

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

Testes usam `.env.test`, que troca o banco para `wagering_test`.

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

## Testes e qualidade

```bash
bun run test              # unitários
bun run test:integration  # integração (requer infra:up)
bun run typecheck         # tsc --noEmit
bun run lint              # biome
bun run format            # biome com correções
bun run check             # typecheck + lint + unitários
```
