import { createHash } from "crypto";
import { PoolClient } from "pg";
import { pool } from "./db";

export class LedgerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface TransferInput {
  idempotencyKey: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: number;
  description?: string;
}

export interface TransferResult {
  transaction_id: string;
  from_account_id: string;
  to_account_id: string;
  amount_minor: number;
  description: string | null;
  replayed: boolean;
}

function hashRequest(i: TransferInput): string {
  return createHash("sha256")
    .update(JSON.stringify([i.fromAccountId, i.toAccountId, i.amountMinor, i.description ?? ""]))
    .digest("hex");
}

async function loadResult(
  client: PoolClient,
  transactionId: string,
  replayed: boolean
): Promise<TransferResult> {
  const { rows } = await client.query(
    `SELECT t.description, e.account_id, e.direction, e.amount_minor
     FROM transactions t
     JOIN ledger_entries e ON e.transaction_id = t.id
     WHERE t.id = $1`,
    [transactionId]
  );
  const debit = rows.find((r) => r.direction === "debit");
  const credit = rows.find((r) => r.direction === "credit");
  return {
    transaction_id: transactionId,
    from_account_id: debit.account_id,
    to_account_id: credit.account_id,
    amount_minor: Number(debit.amount_minor),
    description: debit.description,
    replayed,
  };
}

export async function transfer(input: TransferInput): Promise<TransferResult> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new LedgerError(400, "amount_minor must be a positive whole number (e.g. 2500 = RM25.00)");
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new LedgerError(400, "cannot transfer to the same account");
  }

  const requestHash = hashRequest(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotency: the UNIQUE key on transactions means only one request can claim this key.
    const claim = await client.query(
      `INSERT INTO transactions (idempotency_key, description, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.idempotencyKey, input.description ?? null, requestHash]
    );

    if (claim.rows.length === 0) {
      // Key already used: return the saved result instead of moving money again.
      const existing = await client.query(
        "SELECT id, request_hash FROM transactions WHERE idempotency_key = $1",
        [input.idempotencyKey]
      );
      await client.query("COMMIT");
      if (existing.rows[0].request_hash !== requestHash) {
        throw new LedgerError(422, "Idempotency-Key was already used with a different request");
      }
      return await loadResult(client, existing.rows[0].id, true);
    }

    const transactionId: string = claim.rows[0].id;

    // Lock both accounts (in a fixed order) so two payments can't both spend the same money.
    const accts = await client.query(
      `SELECT id, currency, allow_negative
       FROM accounts
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [[input.fromAccountId, input.toAccountId]]
    );
    if (accts.rows.length !== 2) throw new LedgerError(404, "account not found");

    const from = accts.rows.find((a) => a.id === input.fromAccountId);
    const to = accts.rows.find((a) => a.id === input.toAccountId);
    if (from.currency !== to.currency) {
      throw new LedgerError(400, "accounts must have the same currency");
    }

    if (!from.allow_negative) {
      const bal = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS balance
         FROM ledger_entries WHERE account_id = $1`,
        [input.fromAccountId]
      );
      if (Number(bal.rows[0].balance) < input.amountMinor) {
        throw new LedgerError(422, "insufficient funds");
      }
    }

    // Double entry: one debit and one credit, same amount, same transaction.
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor)
       VALUES ($1, $2, 'debit', $3), ($1, $4, 'credit', $3)`,
      [transactionId, input.fromAccountId, input.amountMinor, input.toAccountId]
    );

    await client.query("COMMIT");
    return await loadResult(client, transactionId, false);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
