import { randomUUID } from "crypto";
import { Request, RequestHandler, Response, Router } from "express";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { pool } from "./db";
import { LedgerError, transfer } from "./ledger";

// Accepts a pacs.008 (FIToFICustomerCreditTransfer) message, moves the money through the
// ledger, and replies with a pacs.002 (FIToFIPaymentStatusReport).
// It is a simplified, single-transaction version of the real messages ("ISO 20022-style"):
// it reads only the fields the ledger needs and does not validate against the full XSD.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true, // so <pacs:Document> and <Document> both work
  parseTagValue: false, // keep "25.00" as text, never as a float
  parseAttributeValue: false,
  trimValues: true,
});

class Rejection extends Error {
  constructor(public httpStatus: number, public code: string, message: string) {
    super(message);
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function statusReport(opts: {
  originalMsgId: string;
  accepted: boolean;
  endToEndId?: string;
  reasonCode?: string;
  info?: string;
}): string {
  const status = opts.accepted ? "ACSC" : "RJCT"; // ACSC = settlement completed, RJCT = rejected
  const reason = opts.accepted
    ? ""
    : `<StsRsnInf><Rsn><Cd>${esc(opts.reasonCode ?? "NARR")}</Cd></Rsn>` +
      `<AddtlInf>${esc(opts.info ?? "")}</AddtlInf></StsRsnInf>`;
  const e2e = opts.endToEndId ? `<OrgnlEndToEndId>${esc(opts.endToEndId)}</OrgnlEndToEndId>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">` +
    `<FIToFIPmtStsRpt>` +
    `<GrpHdr><MsgId>${("STS-" + randomUUID().replace(/-/g, "")).slice(0, 35)}</MsgId>` +
    `<CreDtTm>${new Date().toISOString()}</CreDtTm></GrpHdr>` +
    `<OrgnlGrpInfAndSts><OrgnlMsgId>${esc(opts.originalMsgId)}</OrgnlMsgId>` +
    `<OrgnlMsgNmId>pacs.008.001.08</OrgnlMsgNmId><GrpSts>${status}</GrpSts>${reason}</OrgnlGrpInfAndSts>` +
    `<TxInfAndSts>${e2e}<TxSts>${status}</TxSts>${reason}</TxInfAndSts>` +
    `</FIToFIPmtStsRpt></Document>`
  );
}

// "25.00" -> 2500. Works on the text with whole-number maths, so there are no float rounding errors.
function toMinorUnits(text: string): number {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Rejection(400, "AM02", "amount must be a plain decimal with at most 2 decimals");
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function text(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && typeof (node as Record<string, unknown>)["#text"] === "string") {
    return (node as Record<string, string>)["#text"];
  }
  return undefined;
}

interface Pacs008 {
  msgId: string;
  endToEndId?: string;
  debtorAccount: string;
  creditorAccount: string;
  currency: string;
  amountMinor: number;
}

function parsePacs008(xml: string, onMsgId: (id: string) => void): Pacs008 {
  if (XMLValidator.validate(xml) !== true) {
    throw new Rejection(400, "FF01", "message is not well-formed XML");
  }
  const root = (parser.parse(xml) as any)?.Document?.FIToFICstmrCdtTrf;
  if (!root) throw new Rejection(400, "FF01", "expected a pacs.008 FIToFICstmrCdtTrf message");

  const msgId = text(root.GrpHdr?.MsgId);
  if (!msgId || msgId.length > 35) {
    throw new Rejection(400, "FF01", "GrpHdr/MsgId is required (max 35 characters)");
  }
  onMsgId(msgId);

  const nbOfTxs = text(root.GrpHdr?.NbOfTxs);
  if (Array.isArray(root.CdtTrfTxInf) || (nbOfTxs !== undefined && nbOfTxs !== "1")) {
    throw new Rejection(400, "FF01", "only one CdtTrfTxInf per message is supported");
  }
  const tx = root.CdtTrfTxInf;
  if (!tx) throw new Rejection(400, "FF01", "CdtTrfTxInf is missing");

  const amountNode = tx.IntrBkSttlmAmt;
  const amountText = text(amountNode);
  const currency = amountNode?.["@_Ccy"];
  if (!amountText || typeof currency !== "string") {
    throw new Rejection(400, "AM02", "IntrBkSttlmAmt with a Ccy attribute is required");
  }

  const debtorAccount = text(tx.DbtrAcct?.Id?.Othr?.Id);
  const creditorAccount = text(tx.CdtrAcct?.Id?.Othr?.Id);
  if (!debtorAccount || !UUID_RE.test(debtorAccount)) {
    throw new Rejection(400, "AC01", "DbtrAcct/Id/Othr/Id must be a valid account id");
  }
  if (!creditorAccount || !UUID_RE.test(creditorAccount)) {
    throw new Rejection(400, "AC03", "CdtrAcct/Id/Othr/Id must be a valid account id");
  }

  return {
    msgId,
    endToEndId: text(tx.PmtId?.EndToEndId),
    debtorAccount,
    creditorAccount,
    currency,
    amountMinor: toMinorUnits(amountText),
  };
}

// Maps ledger errors to ISO 20022 external status reason codes.
function reasonFor(err: LedgerError): string {
  if (err.message === "insufficient funds") return "AM04";
  if (err.message === "account not found") return "AC01";
  if (err.message.startsWith("accounts must have the same currency")) return "AM03";
  if (err.message.startsWith("amount_minor must be")) return "AM01";
  if (err.message.startsWith("Idempotency-Key was already used")) return "DUPL";
  return "NARR";
}

const handler: RequestHandler = async (req: Request, res: Response, next) => {
  let originalMsgId = "UNKNOWN";
  let endToEndId: string | undefined;
  const reject = (httpStatus: number, code: string, info: string) =>
    res
      .status(httpStatus)
      .type("application/xml")
      .send(statusReport({ originalMsgId, accepted: false, endToEndId, reasonCode: code, info }));

  try {
    if (typeof req.body !== "string" || req.body.trim() === "") {
      throw new Rejection(415, "FF01", "send the message with Content-Type: application/xml");
    }
    const msg = parsePacs008(req.body, (id) => (originalMsgId = id));
    endToEndId = msg.endToEndId;

    // The message's currency must match the debtor account's currency.
    const acct = await pool.query("SELECT currency FROM accounts WHERE id = $1", [msg.debtorAccount]);
    if (acct.rows.length === 0) throw new Rejection(404, "AC01", "debtor account not found");
    if (String(acct.rows[0].currency).trim() !== msg.currency) {
      throw new Rejection(422, "AM03", "message currency does not match the debtor account currency");
    }

    // The MsgId is the idempotency key: a resent message never moves money twice.
    const result = await transfer({
      idempotencyKey: `pacs008:${msg.msgId}`,
      fromAccountId: msg.debtorAccount,
      toAccountId: msg.creditorAccount,
      amountMinor: msg.amountMinor,
      description: `pacs.008 ${msg.msgId}${msg.endToEndId ? ` / ${msg.endToEndId}` : ""}`,
    });

    res
      .status(result.replayed ? 200 : 201)
      .set("Idempotent-Replayed", String(result.replayed))
      .type("application/xml")
      .send(statusReport({ originalMsgId, accepted: true, endToEndId }));
  } catch (err) {
    if (err instanceof Rejection) return reject(err.httpStatus, err.code, err.message);
    if (err instanceof LedgerError) return reject(err.status, reasonFor(err), err.message);
    next(err);
  }
};

const router = Router();
router.post("/iso20022/pacs008", handler);

export default router;
