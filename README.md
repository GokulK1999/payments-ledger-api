# Payments Ledger API

[![CI](https://github.com/GokulK1999/payments-ledger-api/actions/workflows/ci.yml/badge.svg)](https://github.com/GokulK1999/payments-ledger-api/actions/workflows/ci.yml)

A small backend for moving money safely, built with Node.js, TypeScript and PostgreSQL. It focuses on the problems payment systems have to get right: no double-spending, no duplicate payments on retries, a ledger that always balances, and incoming messages that are verified before they are trusted.

## What it does

- **Double-entry ledger.** Every transaction writes one debit and one credit of equal amount. Balances are calculated from ledger entries, never stored as a number that can drift.
- **Idempotency keys.** Deposits and transfers require an `Idempotency-Key` header. Retrying a request with the same key returns the saved result and moves no money. Reusing a key with a different request is rejected with `422`.
- **Concurrency safety.** Account rows are locked during a transfer, so simultaneous payments cannot spend the same money twice. Five parallel RM40 payments from an RM100 account result in exactly two successes.
- **Signed webhooks.** `POST /webhooks/payments` verifies an HMAC-SHA256 signature, rejects stale timestamps (replay protection) and credits an account once per event ID, even if the event is delivered several times.
- **ISO 20022-style messages.** `POST /iso20022/pacs008` accepts a pacs.008 credit transfer (XML), moves the money through the ledger and replies with a pacs.002 status report.
- **Integer money.** Amounts are stored in minor units (`amount_minor`, e.g. sen or cents), and XML amounts are converted with whole-number maths, so there are no floating-point rounding errors.
- **Input validation.** Invalid account IDs, negative amounts and missing fields return `400`. Insufficient funds returns `422` and moves nothing.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/accounts` | Create an account |
| GET | `/accounts/:id` | Account details and current balance |
| POST | `/accounts/:id/deposits` | Deposit money (requires `Idempotency-Key`) |
| POST | `/transfers` | Transfer between two accounts (requires `Idempotency-Key`) |
| POST | `/webhooks/payments` | Receive a signed payment event (requires `X-Signature`) |
| POST | `/iso20022/pacs008` | Submit a pacs.008 credit transfer, receive a pacs.002 report |

Replayed requests return the original result with the header `Idempotent-Replayed: true`.

### Example: deposit

```bash
curl -X POST http://localhost:3000/accounts/<ACCOUNT_ID>/deposits \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2d3e-0001" \
  -d '{"amount_minor": 10000}'
```

Run the same command again and the balance does not change.

## Signed webhooks

The sender signs every request with a shared secret (`WEBHOOK_SECRET`):

```
X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw request body>">
```

The server rejects the request with `401` if:

- the signature header is missing or malformed,
- the signature does not match the body (tampered or wrong secret),
- the timestamp is more than 5 minutes away from the server's clock (a captured request cannot be replayed later).

Signatures are compared in constant time. The event `id` is used as the idempotency key, so a provider that retries a delivery never credits the account twice.

```bash
export WEBHOOK_SECRET=change-me   # same value the server was started with
BODY='{"id":"evt_1","type":"payment.succeeded","data":{"account_id":"<ACCOUNT_ID>","amount_minor":2500}}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

curl -X POST http://localhost:3000/webhooks/payments \
  -H "Content-Type: application/json" \
  -H "X-Signature: t=$T,v1=$SIG" \
  -d "$BODY"
```

Event types other than `payment.succeeded` are acknowledged with `200` and ignored.

## ISO 20022 messages

`POST /iso20022/pacs008` takes a simplified pacs.008.001.08 message (`Content-Type: application/xml`) with one transaction:

| Field | Used for |
|-------|----------|
| `GrpHdr/MsgId` | Idempotency key. Resending the same `MsgId` moves no money twice. |
| `IntrBkSttlmAmt` + `Ccy` | Amount (decimal, max 2 places) and currency. The currency must match the debtor account. |
| `DbtrAcct/Id/Othr/Id` | Account ID to debit |
| `CdtrAcct/Id/Othr/Id` | Account ID to credit |
| `PmtId/EndToEndId` | Echoed back in the status report |

The response is a pacs.002.001.10 status report: `ACSC` (settlement completed) on success, or `RJCT` with a reason code:

| Code | Meaning | HTTP |
|------|---------|------|
| `FF01` | Malformed XML or missing required field | 400 |
| `AM02` | Invalid amount format | 400 |
| `AM03` | Currency does not match the account | 422 |
| `AM04` | Insufficient funds | 422 |
| `AC01` / `AC03` | Invalid or unknown debtor / creditor account | 400 / 404 |
| `DUPL` | `MsgId` reused with different content | 422 |

This is an ISO 20022-style subset, not a full implementation: it reads only the fields the ledger needs, supports one transaction per message, and does not validate against the full XSD.

## Run it locally

Requires Node.js 22+ and PostgreSQL.

```bash
git clone https://github.com/GokulK1999/payments-ledger-api.git
cd payments-ledger-api
npm install

createdb ledger
psql ledger -f db/schema.sql
psql ledger -f db/002_transfers.sql

WEBHOOK_SECRET=change-me npm run dev
```

The API runs at `http://localhost:3000`.

| Environment variable | Purpose | Default |
|----------------------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://localhost:5432/ledger` |
| `WEBHOOK_SECRET` | Shared secret for webhook signatures. Without it the webhook endpoint returns `500`. | none |
| `PORT` | HTTP port | `3000` |

## Tests

```bash
createdb ledger_test
npm test
```

There are 25 tests using Node's built-in test runner:

- **7 ledger tests:** transfers, idempotent retries, concurrent retries, concurrent overspending.
- **5 API tests:** validation and replayed deposits.
- **7 webhook tests:** valid, wrong secret, missing signature, tampered body, stale timestamp, duplicate delivery, unknown event type.
- **6 ISO 20022 tests:** successful transfer, resent message, insufficient funds, malformed XML, currency mismatch, amount precision.

The tests run against a separate database that is wiped on every run, and refuse to run against any database whose name does not contain `_test`. GitHub Actions runs them against PostgreSQL 16 on every push.

## Project structure

```
src/
  app.ts        HTTP routes and validation
  server.ts     starts the server
  ledger.ts     transfer logic, locking, idempotency
  webhooks.ts   signed webhook verification and handling
  iso20022.ts   pacs.008 parsing and pacs.002 responses
  db.ts         PostgreSQL connection pool
db/             SQL schema and migrations
tests/          ledger, API, webhook and ISO 20022 tests
```

## Design decisions

- **Balances come from entries.** Summing ledger entries means the ledger is the single source of truth.
- **Idempotency is enforced in the database,** so concurrent duplicates are safe, not just sequential ones.
- **Row locks over retries.** Locking the sending account makes overspending impossible rather than merely unlikely.
- **External IDs become idempotency keys.** Webhook event IDs and ISO 20022 message IDs reuse the same mechanism as the HTTP API, so every entry point gets duplicate protection without extra tables.
- **Signatures are checked against the raw bytes,** not re-serialised JSON, so formatting differences cannot break or bypass verification.

## Roadmap

- Multiple transactions per pacs.008 message
- Per-sender webhook secrets and secret rotation
- Full XSD validation of ISO 20022 messages
