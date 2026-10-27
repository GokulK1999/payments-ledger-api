import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "./db";
import { LedgerError, transfer } from "./ledger";

const app = express();
app.use(express.json());

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lets errors thrown inside async routes reach the error handler.
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function getKey(req: Request): string {
  const key = req.header("Idempotency-Key");
  if (!key || key.trim() === "" || key.length > 255) {
    throw new LedgerError(400, "Idempotency-Key header is required (max 255 characters)");
  }
  return key.trim();
}

function sendResult(res: Response, result: Awaited<ReturnType<typeof transfer>>) {
  res
    .status(result.replayed ? 200 : 201)
    .set("Idempotent-Replayed", String(result.replayed))
    .json(result);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Create an account
app.post(
  "/accounts",
  wrap(async (req, res) => {
    const { name, currency = "MYR" } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ error: "name is required" });
    }
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ error: "currency must be a 3-letter code, e.g. MYR" });
    }
    const { rows } = await pool.query(
      "INSERT INTO accounts (name, currency) VALUES ($1, $2) RETURNING id, name, currency, created_at",
      [name.trim(), currency]
    );
    res.status(201).json(rows[0]);
  })
);

// Get an account with its balance (credits minus debits, in minor units)
app.get(
  "/accounts/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "invalid account id" });
    }
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.currency, a.created_at,
              COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor
                                WHEN e.direction = 'debit'  THEN -e.amount_minor END), 0) AS balance_minor
       FROM accounts a
       LEFT JOIN ledger_entries e ON e.account_id = a.id
       WHERE a.id = $1
       GROUP BY a.id`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "account not found" });
    }
    res.json({ ...rows[0], balance_minor: Number(rows[0].balance_minor) });
  })
);

// Move money between two accounts
app.post(
  "/transfers",
  wrap(async (req, res) => {
    const key = getKey(req);
    const { from_account_id, to_account_id, amount_minor, description } = req.body ?? {};
    if (!UUID_RE.test(String(from_account_id)) || !UUID_RE.test(String(to_account_id))) {
      return res.status(400).json({ error: "from_account_id and to_account_id must be valid ids" });
    }
    const result = await transfer({
      idempotencyKey: key,
      fromAccountId: from_account_id,
      toAccountId: to_account_id,
      amountMinor: amount_minor,
      description: typeof description === "string" ? description : undefined,
    });
    sendResult(res, result);
  })
);

// Add money to an account (comes from the External Funding account)
app.post(
  "/accounts/:id/deposits",
  wrap(async (req, res) => {
    const key = getKey(req);
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "invalid account id" });
    }
    const { amount_minor, description } = req.body ?? {};
    const funding = await pool.query(
      `SELECT f.id FROM accounts f
       WHERE f.allow_negative = true
         AND f.currency = (SELECT currency FROM accounts WHERE id = $1)
       LIMIT 1`,
      [id]
    );
    if (funding.rows.length === 0) {
      return res.status(404).json({ error: "account not found or no funding source for its currency" });
    }
    const result = await transfer({
      idempotencyKey: key,
      fromAccountId: funding.rows[0].id,
      toAccountId: id,
      amountMinor: amount_minor,
      description: typeof description === "string" ? description : "deposit",
    });
    sendResult(res, result);
  })
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof LedgerError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Ledger API listening on http://localhost:${PORT}`);
});
