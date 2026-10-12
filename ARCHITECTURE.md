# Architecture

Este documento explica as decisões técnicas, o porquê de cada uma, o que foi deixado de fora e onde estão os limites conhecidos.

## 1. Visão geral

```
          HTTP (POST /wagering/transactions)          SQS (wager-transactions.fifo)
                        │                                        │
                 WageringController                   WagerTransactionConsumer
                        │                                        │  (inbox)
                        └──────────────► SubmitWagerTransaction ◄┘
                                               │
                                  ┌────────────┴─────────────┐
                                  │  transação SQL única      │
                                  │  inbox → lock da wallet → │
                                  │  WagerSettlement (domínio)│
                                  │  wallet + transação +     │
                                  │  ledger + outbox          │
                                  └────────────┬─────────────┘
                                               │ commit
                          ┌────────────────────┴────────────────────┐
                 PublishOutboxEvents (worker)          ResolvePendingReferences (worker)
                          │                                         │
                  wallet-events.fifo                    reprocessa PENDING_REFERENCE
```

Camadas:

- **`domain/`** — classes com construtor privado e factories (`create`, `open`, `rehydrate`). Não conhece NestJS, MikroORM nem SQS. Toda regra de negócio vive aqui, incluindo a decisão de cada operação (`WagerSettlement`).
- **`application/`** — casos de uso e portas (`abstract class` usadas como tokens de injeção). Orquestra a transação, mas não sabe como ela é implementada.
- **`infrastructure/`** — adaptadores: repositórios MikroORM, SQS, workers, logs e métricas.
- **`http/` e `contracts/`** — entrada. HTTP e SQS validam com o mesmo contrato e chamam o **mesmo caso de uso**.

## 2. Dinheiro

- `Money` guarda o valor em **centavos como `bigint`**, nunca `number`. Escala fixa de 2 casas.
- Entrada só por string decimal: `^\d+(\.\d{1,2})?$`. Rejeita `NaN`, `Infinity`, notação científica, vazio, sinal `+`, mais de 2 casas e negativos. **Não há arredondamento**: `0.005` é erro, não `0.01`.
- `"25"`, `"25.5"` e `"25.50"` são aceitos e normalizados para `"25.00"`/`"25.50"` na saída.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda (wallet única por `playerId + currency`), mas os testes usam BRL e cobrem o conflito de moeda.
- No banco: `numeric(20,2)` + coluna `currency char(3)`. O MikroORM devolve `decimal` como string, que é reidratada com `Money.from` — não existe conversão para `number` em nenhum ponto.

## 3. ORM e estratégia transacional

**MikroORM** (preferencial no desafio). As entidades de persistência (`*Entity` + `EntitySchema`) ficam separadas das classes de domínio: o repositório converte `Entity ↔ domínio` usando `rehydrate`. Assim o domínio não tem decorators nem tipos do ORM.

Toda escrita passa por `TransactionManager.run()`, implementado com `em.transactional(..., { clear: true })`:

- abre um fork com identity map limpo (evita ler estado velho de outra transação);
- executa `SET LOCAL lock_timeout` (5s por padrão);
- o Unit of Work faz o flush de wallet, transação, ledger e outbox **no mesmo commit**;
- erros do driver são traduzidos para erros da aplicação (`UniqueViolationError`, `TransientInfrastructureError` com motivo `lock_timeout`/`deadlock`/`connection`).

Algumas operações usam SQL direto pelo `EntityManager` quando o ORM não expressa bem a intenção: `INSERT ... ON CONFLICT DO NOTHING` na inbox, `UPDATE ... FOR UPDATE SKIP LOCKED RETURNING` para os claims de outbox e de referências pendentes, e a paginação/soma do ledger.

As FKs entre `wager_transactions`, `wallet_ledger_entries` e `wallets` são `DEFERRABLE INITIALLY DEFERRED`. Isso deixa o Unit of Work livre para ordenar os inserts e a integridade é verificada no commit.

## 4. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet) dentro da transação.

Por quê:

- a operação crítica é "ler saldo → decidir → gravar"; com o lock da linha isso fica serializado **por wallet**, sem lock global;
- wallets diferentes rodam em paralelo (cada uma tem sua linha);
- funciona igual com 1 ou N instâncias, porque quem serializa é o PostgreSQL;
- comparado a optimistic locking com retry, evita tempestade de retries numa wallet "quente" (muitas apostas na mesma wallet), que é o caso comum em cassino.

O `version` da wallet continua existindo (começa em 1, incrementa só quando o saldo muda) e é verificado no banco por trigger.

Ordem de locks sempre igual — **wallet primeiro, transação depois** — tanto no submit quanto no worker de referências pendentes, para não haver deadlock entre eles.

Fluxo do submit:

1. (SQS) registra a mensagem na inbox (`ON CONFLICT DO NOTHING`). Se já existia → duplicata.
2. procura a transação pela `Idempotency-Key`; se existir → replay (ou conflito, se o hash for diferente).
3. `SELECT ... FOR UPDATE` na wallet.
4. procura de novo pela key — outra requisição idêntica pode ter terminado enquanto esta esperava o lock.
5. resolve a referência (se houver), decide pelo domínio e grava tudo.
6. commit. Só depois disso a resposta HTTP sai ou a mensagem SQS é deletada.

Se mesmo assim duas requisições escaparem (ex.: mesma key apontando para wallets diferentes), a constraint `UNIQUE` estoura no commit, a transação inteira é desfeita e o caso de uso relê pela key para devolver o replay ou o conflito.

**Lock timeout:** se a wallet ficar travada por mais de 5s, a requisição volta `503` com `Retry-After` (ou a mensagem SQS volta para a fila com backoff). Isso é contado em `wallet_lock_conflicts_total`.

O cenário obrigatório (100.00, duas apostas de 80.00) é testado 10 vezes em uma instância e 5 vezes com 3 apostas em 3 processos diferentes.

## 5. Garantias no schema

O código não é a única barreira. O banco impõe:

| Garantia | Como |
|---|---|
| saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK` em `balance_before/after` do ledger |
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| reversão única | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| um lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` no ledger |
| aritmética do lançamento | `CHECK` (`CREDIT`: after = before + amount; `DEBIT`: after = before − amount), `amount > 0` |
| ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| ledger encadeado | trigger: `balance_before` do novo lançamento = `balance_after` do anterior da mesma wallet |
| saldo sempre lastreado no ledger | constraint trigger *deferred*: toda mudança de saldo precisa de um lançamento correspondente (mesmo before/after/timestamp) e `version` tem que subir exatamente 1 |
| transação terminal imutável | trigger bloqueia update de `PROCESSED`/`REJECTED`/`FAILED`, mudança de campos de negócio e `DELETE` |
| coerência de status | `failure_code` presente sse `REJECTED`/`FAILED`; `processed_at` sse `PROCESSED`; `REFUND`/`ROLLBACK` exigem referência |
| inbox | `PRIMARY KEY (consumer_name, message_id)` |

Tudo isso tem teste de integração dedicado (`test/integration/database-constraints.test.ts`).

## 6. Regras de negócio e interpretações

| Operação | Saldo | Ledger | Observações |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | sem saldo → `INSUFFICIENT_FUNDS` |
| `WIN` | crédito | 1 `CREDIT` | referência opcional; se vier, tem que ser `BET` da mesma rodada |
| `LOSS` | — | — | aceita valor `0.00`; referência opcional para `BET` |
| `REFUND` | crédito | 1 `CREDIT` | só referencia `BET` `PROCESSED`, mesmo valor |
| `ROLLBACK` | inverso da referência | 1 invertido | referencia `BET`, `WIN` ou `REFUND` `PROCESSED`, mesmo valor |

Interpretações que adotei:

- **Valor zero:** `BET`, `WIN`, `REFUND` e `ROLLBACK` exigem valor > 0. Só `LOSS` aceita `0.00`.
- **Reversão única por referência, independente do tipo.** O enunciado diz "não pode ser revertida duas vezes pelo mesmo tipo". Fui mais restritivo: uma `BET` reembolsada não pode receber `ROLLBACK` (e vice-versa), porque isso creditaria o jogador duas vezes pela mesma aposta. Reverter a *reversão* continua possível (`ROLLBACK` de um `REFUND`), porque a referência é outra.
- **Referência resolvida por `(providerId, referenceExternalTransactionId)`** e validada: mesmo player, wallet, moeda e rodada; senão `REFERENCE_MISMATCH`.
- **Referência que ainda está pendente** (ex.: `ROLLBACK` de um `WIN` que espera a sua `BET`) → a transação também espera.
- **Referência rejeitada ou falha** → `REFERENCE_NOT_PROCESSED`.
- **`OPENING`** é interno: o contrato de entrada não aceita esse `kind` e o domínio também recusa.
- **Wallet inexistente** não vira linha em `wager_transactions` (não há wallet para a FK); responde `422 WALLET_NOT_FOUND` e, no SQS, é tratado como erro de negócio (ack).

### Estados da transação

```
PENDING ──► PROCESSED          (terminal)
   │   ├──► REJECTED           (terminal)
   │   └──► PENDING_REFERENCE ─┬─► PENDING_REFERENCE   (nova tentativa, attempts + 1)
   │                           ├─► PROCESSED
   │                           ├─► REJECTED  (REFERENCE_NOT_FOUND após o limite, ou outra regra)
   │                           └─► FAILED    (erro permanente inesperado no worker)
   └──► FAILED
```

Transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação) e o banco também recusa.

`PENDING` existe no modelo, mas na prática nunca é persistido: a transação nasce e é decidida dentro do mesmo commit.

### Referências fora de ordem

- Referência ausente → `PENDING_REFERENCE`, `202` no HTTP, evento `WagerTransactionPendingReference` (só na primeira vez).
- O worker `ResolvePendingReferences` roda em todas as instâncias. Ele faz *claim* com `FOR UPDATE SKIP LOCKED` e empurra `next_reference_check_at` para frente (lease de 30s), então duas instâncias não pegam a mesma transação ao mesmo tempo.
- Backoff exponencial: 2s, 4s, 8s ... limitado a 5 min por espera, **até 10 tentativas** (~13,5 min no total). Escolhi esse limite porque, na prática, a operação original chega em segundos; passar de 10+ minutos indica que ela não vai chegar, e o provedor precisa de uma resposta definitiva para conciliar.
- Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

### Códigos de falha

| `failureCode` | Significado | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | não reenviar a mesma transação |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de `WIN`/`REFUND` deixaria saldo negativo | escalar operacionalmente (é diferente de falta de saldo numa aposta) |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `PLAYER_MISMATCH` | a wallet não pertence ao player | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite | investigar/reenviar a original |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/moeda/rodada | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: `REFUND` de um `WIN` | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada | desistir |
| `REFERENCE_ALREADY_REVERSED` | referência já reembolsada/revertida | desistir (já foi aplicado) |
| `AMOUNT_MISMATCH` | valor diferente da referência (reversão parcial não suportada) | corrigir o payload |
| `PROCESSING_ERROR` | erro permanente inesperado no worker (`FAILED`) | contatar o operador |

Erros que **não** viram transação persistida têm `code` no corpo do erro: `INVALID_REQUEST`, `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION`, `IDEMPOTENCY_CONFLICT`, `DUPLICATE_EXTERNAL_TRANSACTION`, `WALLET_NOT_FOUND`, `WALLET_ALREADY_EXISTS`, `TEMPORARILY_UNAVAILABLE`, `NOT_FOUND`.

## 7. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (HTTP) ou `data.idempotencyKey` (SQS). Persistida com `UNIQUE`. Nada de cache em memória.
- **`payloadHash`** = `sha256` em hex do **JSON canônico** (chaves ordenadas recursivamente, sem espaços, `undefined` omitido) deste subconjunto:

  ```
  providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money { amount (normalizado, 2 casas), currency }, referenceExternalTransactionId (ou null)
  ```

  Ficam de fora: a própria key, `messageId`, `occurredAt`, `type`, headers e qualquer metadado de transporte. O `amount` é normalizado antes do hash, então `"10"` e `"10.00"` são o mesmo payload.
- Mesma key + mesmo hash → **replay** com o resultado original (status, `failureCode` e o **saldo observado naquele momento**, que fica gravado em `observed_balance`).
- Mesma key + hash diferente → `409 IDEMPOTENCY_CONFLICT`. Nunca replay.
- Mesmo `(providerId, externalTransactionId)` com outra key → `409 DUPLICATE_EXTERNAL_TRANSACTION`.

## 8. SQS

- O consumidor recebe em lote, agrupa por `MessageGroupId` (a wallet) e processa grupos em paralelo, mas mensagens do mesmo grupo em ordem.
- Valida o envelope com o mesmo contrato do HTTP e chama **o mesmo `SubmitWagerTransaction`**, passando `inbox: { consumerName, messageId }`.
- **Inbox:** `(consumer_name, message_id)` é registrada dentro da mesma transação SQL da operação financeira. Redelivery → `ON CONFLICT DO NOTHING` → duplicata → devolve o resultado original → ack. Mesmo `messageId` com payload diferente → DLQ.
- **Ack (delete) só depois do commit.** Se o processo morre entre o commit e o ack, a mensagem volta após o visibility timeout e cai na inbox como duplicata (teste com processo real morto: `multi-instance.test.ts`).
- Classificação de erros:

  | Tipo | Exemplos | Ação |
  |---|---|---|
  | negócio | wallet inexistente, `DUPLICATE_EXTERNAL_TRANSACTION`, regra de domínio | ack (terminal; já logado) |
  | transitório | lock timeout, deadlock, banco/SQS fora, erro inesperado | `ChangeMessageVisibility` com backoff `2^receiveCount` s (máx. 300s) |
  | permanente | JSON inválido, contrato inválido, `IDEMPOTENCY_CONFLICT` | envia para a DLQ e deleta |

- Limite de tentativas: `SQS_MAX_RECEIVE_COUNT` (5). Ao atingir, o consumidor manda para a DLQ explicitamente (para contar na métrica). A fila também tem `RedrivePolicy` com o mesmo limite como rede de segurança.
- **SIGTERM:** `enableShutdownHooks()` → o consumidor para de buscar, aborta o long polling, termina a mensagem em andamento e devolve as demais do lote com `VisibilityTimeout = 0`. Testado em `sqs-consumer.test.ts`.
- FIFO ajuda na ordem e no dedup, mas **não é a garantia**: a inbox e as constraints são.

## 9. Transactional Outbox

- Os eventos são gravados em `outbox_messages` na mesma transação da operação. Nenhum evento é publicado antes do commit.
- O publisher roda em todas as instâncias. Cada ciclo faz *claim* com `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, marcando `locked_until` (lease de 30s). Dois publishers nunca pegam o mesmo evento ao mesmo tempo; se um morre no meio, o lease expira e outro assume.
- Sucesso → `published_at`. Falha → `attempts + 1`, `next_attempt_at` com backoff exponencial (1s ... 60s) e `last_error`.
- **Entrega at-least-once.** Se o processo morre depois de publicar e antes de marcar, o evento sai de novo. Isso é seguro porque: todo envelope carrega `eventId`, e a fila de eventos é FIFO com `MessageDeduplicationId = eventId` (o SQS descarta a duplicata dentro da janela de 5 min). Consumidores devem deduplicar por `eventId` fora dessa janela.
- Destino: `wallet-events.fifo`, `MessageGroupId = aggregateId`, atributo `eventType`. O enunciado só define as filas de entrada, então criei essa fila para os eventos.

Eventos: `WagerTransactionProcessed` (inclusive `LOSS` e `OPENING`), `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` (só quando o saldo muda). Cada um é uma subclasse de `IntegrationEvent<T>` com `eventType` e `version` no próprio tipo; `data` carrega `MoneyProps` (string), nunca `Money`.

## 10. Reconciliação

`POST /wallets/:id/reconciliation` trava a wallet em modo compartilhado (`FOR SHARE`), soma créditos e débitos do ledger e compara com o saldo materializado. Divergência **não é corrigida**: é logada como erro, conta em `wallet_reconciliation_mismatches_total` e volta `consistent: false`. Na prática, os triggers do schema tornam a divergência muito difícil de acontecer, mas a verificação existe justamente para o caso de alguém mexer no banco por fora.

## 11. Observabilidade

- **Logs JSON** (`JsonLogger`) com `timestamp`, `level`, `instance`, `context` e os campos de contexto `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, propagados com `AsyncLocalStorage`. HTTP aceita/devolve `x-correlation-id`. Chaves como `payload`, `money`, `balance` e `authorization` são removidas antes de escrever.
- **Métricas** (`GET /metrics`):

  | Métrica | O que mede |
  |---|---|
  | `wager_transactions_total{status,kind,source}` | transações por status |
  | `wager_duplicates_total{layer}` | duplicatas (idempotência / inbox) |
  | `wager_retries_total{reason}` | retries (SQS transitório, referência pendente, publish da outbox) |
  | `sqs_dlq_messages_total{reason}` | mensagens enviadas à DLQ |
  | `wallet_lock_conflicts_total{reason}` | lock timeout e deadlock |
  | `outbox_lag_seconds`, `outbox_pending_messages` | idade do evento mais antigo não publicado e backlog |
  | `wager_processing_duration_seconds` | latência de processamento (histograma) |
  | `wallet_reconciliation_mismatches_total` | divergências de reconciliação |

- **Health:** `/health/live` (processo de pé) e `/health/ready` (PostgreSQL `SELECT 1` e SQS `GetQueueAttributes`, com timeout de 2s cada). Ambos sem autenticação.

## 12. Autenticação

Não implementei, por decisão de timebox — o desafio deixa claro que não vale pontos. O ponto de extensão está no código:

- `AuthGuard` global com `@Public()` para health e métricas;
- `ProviderIdentityPort`, hoje com `AllowAllProviderIdentity`.

Desenho que eu adotaria: **Keycloak** no compose, um *client* por provedor com `client_credentials`; o provedor manda `Authorization: Bearer <jwt>`; uma implementação de `ProviderIdentityPort` valida assinatura via JWKS, `iss`, `aud` e `exp`, e o guard compara o `azp`/`client_id` do token com o `providerId` do corpo (provedor A não pode lançar transações em nome do provedor B). Mensagens da fila continuam tratadas como canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## 13. Testes

| Suíte | O que prova |
|---|---|
| `test/unit` | `Money` (escala, sem arredondamento, entradas inválidas, moedas), invariantes da `Wallet`, transições da `WagerTransaction`, regras de cada `kind`, eventos e outbox |
| `database-constraints` | migrations up/down/up e cada constraint/trigger do schema |
| `wagering-api` | API ponta a ponta, replay, conflito, rodada completa, referência fora de ordem, esgotamento de tentativas, **atomicidade** (falha na outbox desfaz wallet, transação e ledger) |
| `sqs-consumer` | mesmo use case, inbox/redelivery, crash depois do commit, DLQ para inválidos, retry com backoff até DLQ, recuperação após falha transitória, shutdown |
| `outbox` | publicação, **dois publishers concorrentes** sem claim duplicado, recuperação após instância morta, lease expirado, retry com backoff, publicação duplicada inofensiva |
| `hot-wallet` | mesma `BET` 50x em paralelo, 80+80 sobre 100 (10 rodadas), retries não duplicam, wallet quente com BET/WIN misturados, 25 wallets em paralelo, `REFUND`/`ROLLBACK` correndo contra a `BET` |
| `multi-instance` | **3 processos reais** da aplicação: worker morto (processo encerrado) depois do commit e antes do ack, HTTP espalhado entre instâncias, 80+80+80 em 3 instâncias, 3 consumidores na mesma fila com redeliveries, **kill -9 de uma instância no meio da carga e restart**, todos os eventos publicados pelos 3 publishers |

Invariante verificada nos testes: `wallet.balance == soma do ledger == balance_after do último lançamento`.

Nenhum teste substitui PostgreSQL ou SQS por mock. Os poucos *test doubles* são pontuais (trocar um método de um serviço já montado para simular um broker fora ou um erro transitório).

## 14. Teste de carga

`bun run test:load` cria 20 wallets e dispara 3000 requisições (`BET` 70% / `WIN` 30%, 10% de reenvios com a mesma key) com 50 conexões simultâneas, distribuídas aleatoriamente entre as 3 instâncias do compose. No fim, espera a outbox esvaziar e reconcilia todas as wallets.

**Ambiente:** notebook Windows 11, Docker Desktop (WSL2), as 3 instâncias + PostgreSQL 17 + LocalStack 4.4 na mesma máquina; o gerador de carga roda no host. Ou seja, tudo disputa a mesma CPU — os números servem para comparar, não como capacidade de produção.

| Rodada | Throughput | p50 | p95 | p99 | Erros (503) | Lock conflicts | Outbox: tempo para zerar | Wallets consistentes |
|---|---|---|---|---|---|---|---|---|
| 1 | 174 req/s | 231 ms | 719 ms | 971 ms | 4 (0,13%) | — ¹ | 9,1 s | sim |
| 2 | 169 req/s | 245 ms | 718 ms | 1171 ms | 5 (0,17%) | 5 | 8,8 s | sim |
| 3 | 169 req/s | 238 ms | 716 ms | 1163 ms | 5 (0,17%) | 5 | 13,0 s | sim |

¹ Na primeira rodada o lock timeout estava sendo classificado como erro de conexão e não aparecia na métrica; o teste de carga revelou isso e foi corrigido (`fix(database): classify lock timeouts and deadlocks by sqlstate`).

Leitura honesta:

- **Os 503 são lock timeouts** em wallets quentes (20 wallets para 50 conexões simultâneas = muita fila no mesmo lock). Não há efeito parcial: a requisição é desfeita inteira e o cliente pode reenviar com a mesma key. Uma coisa que não consegui explicar completamente: em algumas rodadas a latência medida no cliente para esses 503 foi menor que os 5s configurados; o próprio PostgreSQL registra `canceling statement due to lock timeout ... while locking tuple`, então é o lock da linha, mas a causa exata do tempo menor ficou em aberto.
- **Nenhuma duplicidade, nenhum saldo negativo, todas as wallets reconciliadas.**
- **O gargalo de latência é o lock por wallet**, o que é esperado e desejado: a mesma wallet é serializada. Wallets diferentes escalam.
- **Outbox leva de 9 a 13s para zerar depois da carga.** O publisher envia lotes de 10 em sequência; com ~5.400 eventos gerados em ~17s ele fica para trás e precisa de alguns segundos para zerar. Melhorias óbvias: enviar os lotes em paralelo e aumentar o batch de claim.

## 15. Limitações e o que eu faria com mais tempo

- **Autenticação** (seção 12).
- **Pool de conexões x espera de lock:** uma requisição esperando o lock da wallet segura uma conexão do pool. Sob contenção extrema numa única wallet, o pool satura antes do lock timeout. Alternativas: fila em memória por wallet antes de pegar conexão (só otimização, nunca garantia), ou limitar concorrência por wallet no consumidor.
- **Partidas dobradas** (diferencial opcional) não implementado: o ledger é de entrada simples por wallet.
- **Retenção:** inbox e outbox crescem para sempre. Em produção, um job apagaria inbox processada após N dias e outbox publicada após a janela de auditoria.
- **Eventos de saída:** só há uma fila de eventos; em produção seria um tópico SNS/EventBridge com fan-out.
- **OpenTelemetry e dashboard** não foram feitos; as métricas Prometheus e o `correlationId` cobrem o diagnóstico básico.
- **Reversão parcial** está fora de escopo (o valor precisa ser igual ao da referência).
