import "./env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import app from "../src/app";
import { pool } from "../src/db";
import { newAccount, balanceOf, fund } from "./helpers";

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

function pacs008(o: { msgId?: string; from: string; to: string; amount?: string; ccy?: string }) {
  const msgId = o.msgId ?? `MSG-${randomUUID().slice(0, 20)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>2026-10-28T09:00:00Z</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId><EndToEndId>E2E-1001</EndToEndId></PmtId>
      <IntrBkSttlmAmt Ccy="${o.ccy ?? "MYR"}">${o.amount ?? "25.00"}</IntrBkSttlmAmt>
      <DbtrAcct><Id><Othr><Id>${o.from}</Id></Othr></Id></DbtrAcct>
      <CdtrAcct><Id><Othr><Id>${o.to}</Id></Othr></Id></CdtrAcct>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;
}

function send(xml: string, contentType = "application/xml") {
  return fetch(base + "/iso20022/pacs008", { method: "POST", headers: { "Content-Type": contentType }, body: xml });
}

test("a valid pacs.008 moves money and returns a pacs.002 ACSC report", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);
  const msgId = `MSG-${randomUUID().slice(0, 20)}`;

  const res = await send(pacs008({ msgId, from: a, to: b, amount: "25.00" }));
  const xml = await res.text();

  assert.equal(res.status, 201);
  assert.match(res.headers.get("content-type") ?? "", /xml/);
  assert.match(xml, /pacs\.002\.001\.10/);
  assert.match(xml, /<GrpSts>ACSC<\/GrpSts>/);
  assert.ok(xml.includes(`<OrgnlMsgId>${msgId}</OrgnlMsgId>`));
  assert.equal(await balanceOf(a), 7500);
  assert.equal(await balanceOf(b), 2500);
});

test("resending the same pacs.008 MsgId does not move money twice", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);
  const xml = pacs008({ from: a, to: b, amount: "25.00" });

  const first = await send(xml);
  const second = await send(xml);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("idempotent-replayed"), "true");
  assert.match(await second.text(), /<GrpSts>ACSC<\/GrpSts>/);
  assert.equal(await balanceOf(a), 7500);
  assert.equal(await balanceOf(b), 2500);
});

test("insufficient funds returns RJCT with reason AM04 and moves nothing", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 1000);

  const res = await send(pacs008({ from: a, to: b, amount: "50.00" }));
  const xml = await res.text();

  assert.equal(res.status, 422);
  assert.match(xml, /<GrpSts>RJCT<\/GrpSts>/);
  assert.match(xml, /<Cd>AM04<\/Cd>/);
  assert.equal(await balanceOf(a), 1000);
  assert.equal(await balanceOf(b), 0);
});

test("malformed XML returns RJCT with reason FF01", async () => {
  const res = await send("<Document><FIToFICstmrCdtTrf><GrpHdr></Document>");
  const xml = await res.text();
  assert.equal(res.status, 400);
  assert.match(xml, /<Cd>FF01<\/Cd>/);
});

test("a message currency that differs from the account currency is rejected (AM03)", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);

  const res = await send(pacs008({ from: a, to: b, amount: "10.00", ccy: "USD" }));

  assert.equal(res.status, 422);
  assert.match(await res.text(), /<Cd>AM03<\/Cd>/);
  assert.equal(await balanceOf(a), 10000);
  assert.equal(await balanceOf(b), 0);
});

test("an amount with too many decimals is rejected instead of rounded", async () => {
  const a = await newAccount();
  const b = await newAccount();
  await fund(a, 10000);

  const res = await send(pacs008({ from: a, to: b, amount: "10.005" }));

  assert.equal(res.status, 400);
  assert.match(await res.text(), /<Cd>AM02<\/Cd>/);
  assert.equal(await balanceOf(a), 10000);
});
