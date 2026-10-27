CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'MYR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
