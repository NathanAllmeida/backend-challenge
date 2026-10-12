# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, por HTTP ou SQS, mantendo saldo, ledger, idempotência e eventos corretos mesmo com mensagens duplicadas, fora de ordem e várias instâncias rodando ao mesmo tempo.

O enunciado original está em [`CHALLENGE.md`](CHALLENGE.md). As decisões técnicas, trade-offs e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

- Bun 1.x + TypeScript (strict)
- NestJS 11
- PostgreSQL 17 + MikroORM 6 (migrations versionadas e reversíveis)
- AWS SQS via LocalStack
- Docker Compose
- Prometheus (`prom-client`) para métricas

## Subindo tudo com Docker

```bash
docker compose up -d --build
```

Isso sobe:

| Serviço | Porta | O que é |
|---|---|---|
| `postgres` | 5432 | banco `wallet` (e `wallet_test` para os testes) |
| `localstack` | 4566 | SQS |
| `setup` | — | roda as migrations e cria as filas, depois sai |
| `app-1`, `app-2`, `app-3` | 3001, 3002, 3003 | três instâncias da aplicação, todas com HTTP, consumidor SQS, publisher da outbox e worker de referências pendentes |

As três instâncias compartilham banco e filas de propósito: é assim que a solução é validada contra concorrência entre processos.

```bash
curl localhost:3001/health/ready
```

## Rodando localmente (fora do container)

```bash
docker compose up -d postgres localstack
cp .env.example .env
bun install
bun run migration:up
bun run queues:setup
bun run dev
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `bun run dev` | sobe a aplicação (dev com watch) |
| `bun run migration:up` / `bun run migration:down` | aplica / reverte migrations |
| `bun run queues:setup` | cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive) e `wallet-events.fifo` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | toda a suíte |
| `bun run test:unit` | domínio puro, sem infraestrutura |
| `bun run test:integration` | PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | paralelismo real, incluindo 3 processos da aplicação |
| `bun run test:load` | teste de carga contra as instâncias do compose |

Os testes de integração e concorrência precisam de `postgres` e `localstack` de pé (`docker compose up -d postgres localstack`). Eles usam o banco `wallet_test` (recriado a cada arquivo) e filas com sufixo único por execução, então não interferem com as instâncias do compose.

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet; saldo inicial > 0 gera transação `OPENING` + crédito no ledger na mesma transação SQL |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado com cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo materializado com o ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live` / `/health/ready` | liveness / readiness (PostgreSQL + SQS) |
| `GET` | `/metrics` | métricas Prometheus |

Exemplo:

```bash
curl -X POST localhost:3001/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -X POST localhost:3002/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"player-1","walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

### Status HTTP

| Situação | Status | Pode reenviar? |
|---|---|---|
| transação aplicada (primeira vez) | `201` | — |
| replay idêntico | `200` com `idempotentReplay: true` | — |
| aceita, aguardando referência (`PENDING_REFERENCE`) | `202` | não precisa |
| rejeitada por regra de negócio (`REJECTED` + `failureCode`) | `422` | não com o mesmo payload |
| wallet inexistente | `422` (`WALLET_NOT_FOUND`) | não |
| payload inválido / header ausente | `400` | corrigir o payload |
| mesma `Idempotency-Key` com payload diferente | `409` (`IDEMPOTENCY_CONFLICT`) | não |
| mesmo `externalTransactionId` com outra key | `409` (`DUPLICATE_EXTERNAL_TRANSACTION`) | não |
| falha transitória (lock timeout, banco fora) | `503` + `Retry-After` | sim, com a mesma key |

A tabela completa de `failureCode` está no `ARCHITECTURE.md`.

## Estrutura

```
src/
  domain/           regras de negócio puras (Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos)
  application/      casos de uso, portas (repositórios, transação, métricas, publisher)
  contracts/        validação de entrada compartilhada entre HTTP e SQS
  http/             controllers, guard de autenticação, filtro de erros
  infrastructure/   MikroORM, SQS, workers, logs e métricas
  config/           configuração vinda do ambiente
test/
  unit/             domínio
  integration/      banco, API, SQS, outbox
  concurrency/      paralelismo real e múltiplos processos
  load/             teste de carga
```

## Como usei IA neste desafio

Usei o Claude (Anthropic) como par de programação: para discutir alternativas de locking e de outbox, gerar a primeira versão de parte dos testes e revisar casos de borda (ex.: `ROLLBACK` de uma `BET` já reembolsada, lock timeout classificado errado como erro de conexão). As decisões, a revisão do código e a validação — rodando tudo contra Postgres e LocalStack reais — foram minhas. Os pontos em que a IA errou e eu corrigi estão refletidos no histórico de commits (`fix: ...`).
