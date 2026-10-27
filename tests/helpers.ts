import { randomUUID } from "crypto";
import { pool } from "../src/db";
import { transfer } from "../src/ledger";

export const key = () => randomUUID();

export async function newAccount(name = "test account", currency = "MYR"): Promise<string> {
  const { rows } = await pool.query(
    "INSERT INTO accounts (name, currency) VALUES ($1, $2) RETURNING id",
    [name, currency]
  );
  return rows[0].id;
}

export async function balanceOf(accountId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS balance
     FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return Number(rows[0].balance);
}

export async function fund(accountId: string, amountMinor: number) {
  const { rows } = await pool.query(
    "SELECT id FROM accounts WHERE allow_negative = true AND currency = 'MYR' LIMIT 1"
  );
  return transfer({
    idempotencyKey: key(),
    fromAccountId: rows[0].id,
    toAccountId: accountId,
    amountMinor,
    description: "test funding",
  });
}
