# Payments Ledger API

[![CI](https://github.com/GokulK1999/payments-ledger-api/actions/workflows/ci.yml/badge.svg)](https://github.com/GokulK1999/payments-ledger-api/actions/workflows/ci.yml)

A small backend for moving money safely, built with Node.js, TypeScript and PostgreSQL. It focuses on the problems payment systems have to get right: no double-spending, no duplicate payments on retries, and a ledger that always balances.

## What it does

- **Double-entry ledger.** Every transaction writes one debit and one credit of equal amount. Balances are calculated from ledger entries, never stored as a number that can drift.
- **Idempotency keys.** Deposits and transfers require an `Idempotency-Key` header. Retrying a request with the same key returns the saved result and moves no money. Reusing a key with a different request is rejected with `422`.
- **Concurrency safety.** Account rows are locked during a transfer, so simultaneous payments cannot spend the same money twice. Five parallel RM40 payments from an RM100 account result in exactly two successes.
- **Integer money.** Amounts are stored in minor units (`amount_minor`, e.g. sen or cents), so there are no floating-point rounding errors.
- **Input validation.** Invalid account IDs, negative amounts and missing fields return `400`. Insufficient funds returns `422` and moves nothing.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/accounts` | Create an account |
| GET | `/accounts/:id` | Account details and current balance |
| POST | `/accounts/:id/deposits` | Deposit money (requires `Idempotency-Key`) |
| POST | `/transfers` | Transfer between two accounts (requires `Idempotency-Key`) |

Replayed requests return the original result with the header `Idempotent-Replayed: true`.

### Example

```bash
curl -X POST http://localhost:3000/accounts/<ACCOUNT_ID>/deposits \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2d3e-0001" \
  -d '{"amount_minor": 10000}'
```

Run the same command again and the balance does not change.

## Run it locally

Requires Node.js 22+ and PostgreSQL.

```bash
git clone https://github.com/GokulK1999/payments-ledger-api.git
cd payments-ledger-api
npm install

createdb ledger
psql ledger -f db/schema.sql
psql ledger -f db/002_transfers.sql

npm run dev
```

The API runs at `http://localhost:3000`. Set `DATABASE_URL` if your database is not at `postgres://localhost:5432/ledger`.

## Tests

```bash
createdb ledger_test
npm test
```

There are 12 tests using Node's built-in test runner: 7 on the ledger logic (including concurrent retries and concurrent overspending) and 5 on the HTTP API. The tests run against a separate database that is wiped on every run, and refuse to run against any database whose name does not contain `_test`. GitHub Actions runs them against PostgreSQL 16 on every push.

## Project structure

```
src/
  app.ts        HTTP routes and validation
  server.ts     starts the server
  ledger.ts     transfer logic, locking, idempotency
  db.ts         PostgreSQL connection pool
db/             SQL schema and migrations
tests/          ledger and API tests
```

## Design decisions

- **Balances come from entries.** Summing ledger entries means the ledger is the single source of truth.
- **Idempotency is enforced in the database,** so concurrent duplicates are safe, not just sequential ones.
- **Row locks over retries.** Locking the sending account makes overspending impossible rather than merely unlikely.

## Roadmap

- Signed webhooks for payment events
- ISO 20022-style message handling
