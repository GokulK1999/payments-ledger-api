import "./env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import app from "../src/app";
import { pool } from "../src/db";
import { signPayload } from "../src/webhooks";
import { newAccount, balanceOf } from "./helpers";

const SECRET = process.env.WEBHOOK_SECRET!;
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

const now = () => Math.floor(Date.now() / 1000);

function event(accountId: string, amountMinor = 2500, id = `evt_${randomUUID()}`) {
  return { id, type: "payment.succeeded", data: { account_id: accountId, amount_minor: amountMinor } };
}

// Sends a webhook. By default it is signed correctly; the options let a test break one thing.
function send(
  body: object,
  opts: { timestamp?: number; secret?: string; signedBody?: string; header?: string | null } = {}
) {
  const raw = JSON.stringify(body);
  const t = opts.timestamp ?? now();
  const sig = signPayload(opts.secret ?? SECRET, t, opts.signedBody ?? raw);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.header !== null) headers["X-Signature"] = opts.header ?? `t=${t},v1=${sig}`;
  return fetch(base + "/webhooks/payments", { method: "POST", headers, body: raw });
}

test("a correctly signed payment.succeeded webhook credits the account", async () => {
  const id = await newAccount();
  const res = await send(event(id, 2500));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, false);
  assert.equal(await balanceOf(id), 2500);
});

test("a webhook with a wrong signature is rejected and no money moves", async () => {
  const id = await newAccount();
  const res = await send(event(id), { secret: "not-the-real-secret" });
  assert.equal(res.status, 401);
  assert.equal(await balanceOf(id), 0);
});

test("a webhook with no signature header is rejected", async () => {
  const id = await newAccount();
  const res = await send(event(id), { header: null });
  assert.equal(res.status, 401);
  assert.equal(await balanceOf(id), 0);
});

test("a body changed after signing is rejected", async () => {
  const id = await newAccount();
  const signedFor = JSON.stringify(event(id, 100)); // signature covers RM1.00...
  const res = await send(event(id, 999900), { signedBody: signedFor }); // ...but RM9,999 is sent
  assert.equal(res.status, 401);
  assert.equal(await balanceOf(id), 0);
});

test("a genuinely signed but old webhook is rejected (replay protection)", async () => {
  const id = await newAccount();
  const res = await send(event(id), { timestamp: now() - 3600 });
  assert.equal(res.status, 401);
  assert.equal(await balanceOf(id), 0);
});

test("the same event delivered twice credits the account only once", async () => {
  const id = await newAccount();
  const e = event(id, 4000);

  const first = await send(e);
  const second = await send(e);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(await balanceOf(id), 4000);
});

test("an unknown event type is acknowledged and ignored", async () => {
  const id = await newAccount();
  const res = await send({ id: `evt_${randomUUID()}`, type: "customer.updated", data: { account_id: id } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, true);
  assert.equal(await balanceOf(id), 0);
});
