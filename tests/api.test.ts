import "./env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "http";
import type { AddressInfo } from "net";
import app from "../src/app";
import { pool } from "../src/db";
import { newAccount, key } from "./helpers";

let server: Server;
let base = "";

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

function post(path: string, idempotencyKey: string | null, body: object) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
}

test("GET /health returns ok", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("a deposit without an Idempotency-Key is rejected", async () => {
  const id = await newAccount();
  const res = await post(`/accounts/${id}/deposits`, null, { amount_minor: 1000 });
  assert.equal(res.status, 400);
});

test("a repeated deposit returns the saved result and credits only once", async () => {
  const id = await newAccount();
  const k = key();

  const first = await post(`/accounts/${id}/deposits`, k, { amount_minor: 10000 });
  const second = await post(`/accounts/${id}/deposits`, k, { amount_minor: 10000 });

  assert.equal(first.status, 201);
  assert.equal(first.headers.get("idempotent-replayed"), "false");
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("idempotent-replayed"), "true");

  const account = await (await fetch(`${base}/accounts/${id}`)).json();
  assert.equal(account.balance_minor, 10000);
});

test("an invalid account id is rejected", async () => {
  const res = await fetch(base + "/accounts/not-a-real-id");
  assert.equal(res.status, 400);
});

test("a negative or missing amount is rejected", async () => {
  const id = await newAccount();
  const negative = await post(`/accounts/${id}/deposits`, key(), { amount_minor: -5 });
  const missing = await post(`/accounts/${id}/deposits`, key(), {});
  assert.equal(negative.status, 400);
  assert.equal(missing.status, 400);
});
