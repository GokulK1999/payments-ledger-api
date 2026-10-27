import "./env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db";
import { transfer, LedgerError } from "../src/ledger";
import { newAccount, balanceOf, fund, key } from "./helpers";

after(async () => {
  await pool.end();
});

test("a transfer moves money and updates both balances", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);

  const result = await transfer({ idempotencyKey: key(), fromAccountId: a, toAccountId: b, amountMinor: 2500 });

  assert.equal(result.replayed, false);
  assert.equal(await balanceOf(a), 7500);
  assert.equal(await balanceOf(b), 2500);
});

test("retrying with the same idempotency key does not move money twice", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);
  const k = key();
  const request = { idempotencyKey: k, fromAccountId: a, toAccountId: b, amountMinor: 2500 };

  const first = await transfer(request);
  const second = await transfer(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.transaction_id, first.transaction_id);
  assert.equal(await balanceOf(a), 7500);
  assert.equal(await balanceOf(b), 2500);
});

test("the same key with a different request is rejected", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);
  const k = key();

  await transfer({ idempotencyKey: k, fromAccountId: a, toAccountId: b, amountMinor: 2500 });

  await assert.rejects(
    transfer({ idempotencyKey: k, fromAccountId: a, toAccountId: b, amountMinor: 9999 }),
    (err: unknown) => err instanceof LedgerError && err.status === 422
  );
  assert.equal(await balanceOf(a), 7500);
});

test("insufficient funds is rejected and no money moves", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 1000);

  await assert.rejects(
    transfer({ idempotencyKey: key(), fromAccountId: a, toAccountId: b, amountMinor: 5000 }),
    (err: unknown) => err instanceof LedgerError && err.status === 422 && err.message === "insufficient funds"
  );
  assert.equal(await balanceOf(a), 1000);
  assert.equal(await balanceOf(b), 0);
});

test("every transaction has one debit and one credit of equal amount", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);
  const result = await transfer({ idempotencyKey: key(), fromAccountId: a, toAccountId: b, amountMinor: 3300 });

  const { rows } = await pool.query(
    "SELECT direction, amount_minor FROM ledger_entries WHERE transaction_id = $1 ORDER BY direction",
    [result.transaction_id]
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].direction, "credit");
  assert.equal(rows[1].direction, "debit");
  assert.equal(Number(rows[0].amount_minor), Number(rows[1].amount_minor));
});

test("5 simultaneous requests with the same key move money only once", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);
  const request = { idempotencyKey: key(), fromAccountId: a, toAccountId: b, amountMinor: 2500 };

  const results = await Promise.all(Array.from({ length: 5 }, () => transfer(request)));

  assert.equal(new Set(results.map((r) => r.transaction_id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(await balanceOf(a), 7500);
  assert.equal(await balanceOf(b), 2500);
});

test("simultaneous payments cannot spend the same money twice", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);

  // 5 different payments of RM40 from an account holding RM100: only 2 can succeed.
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      transfer({ idempotencyKey: key(), fromAccountId: a, toAccountId: b, amountMinor: 4000 })
    )
  );

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(await balanceOf(a), 2000);
  assert.equal(await balanceOf(b), 8000);
});
