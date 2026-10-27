import { createHmac, timingSafeEqual } from "crypto";
import { RequestHandler, Request, Router } from "express";
import { LedgerError, findFundingAccount, transfer } from "./ledger";

// Webhook signing, in the style used by Stripe and others:
//   X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// Including the timestamp in the signed text stops an attacker from replaying
// an old, genuinely signed request later.

const TOLERANCE_SECONDS = 300; // reject anything older (or newer) than 5 minutes
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signPayload(secret: string, timestamp: string | number, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

function verifySignature(req: Request): void {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new LedgerError(500, "webhook secret is not configured on the server");
  }

  const header = req.header("X-Signature") ?? "";
  const timestamp = /(?:^|,)\s*t=(\d{1,12})(?=,|$)/.exec(header)?.[1];
  const signature = /(?:^|,)\s*v1=([0-9a-fA-F]{64})(?=,|$)/.exec(header)?.[1];
  if (!timestamp || !signature) {
    throw new LedgerError(401, "missing or malformed X-Signature header");
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    throw new LedgerError(400, "request body must be JSON");
  }

  const expected = Buffer.from(signPayload(secret, timestamp, rawBody), "hex");
  const received = Buffer.from(signature, "hex");
  // timingSafeEqual avoids leaking how many characters matched.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new LedgerError(401, "invalid signature");
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > TOLERANCE_SECONDS) {
    throw new LedgerError(401, "timestamp outside the allowed window");
  }
}

const router = Router();

// A payment provider tells us that money arrived for an account.
//   { "id": "evt_123", "type": "payment.succeeded",
//     "data": { "account_id": "<uuid>", "amount_minor": 2500 } }
const paymentWebhook: RequestHandler = async (req, res, next) => {
  try {
    verifySignature(req);

    const event = req.body ?? {};
    if (typeof event.id !== "string" || event.id.trim() === "" || event.id.length > 200) {
      throw new LedgerError(400, "event id is required (max 200 characters)");
    }
    if (typeof event.type !== "string") {
      throw new LedgerError(400, "event type is required");
    }
    if (event.type !== "payment.succeeded") {
      // Acknowledge event types we don't handle, so the sender doesn't keep retrying them.
      return res.status(200).json({ received: true, ignored: true });
    }

    const accountId = String(event.data?.account_id);
    if (!UUID_RE.test(accountId)) {
      throw new LedgerError(400, "data.account_id must be a valid account id");
    }
    const fundingId = await findFundingAccount(accountId);
    if (!fundingId) {
      throw new LedgerError(404, "account not found or no funding source for its currency");
    }

    // The event id is the idempotency key: a webhook delivered twice credits the account once.
    const result = await transfer({
      idempotencyKey: `webhook:${event.id}`,
      fromAccountId: fundingId,
      toAccountId: accountId,
      amountMinor: event.data?.amount_minor,
      description: `webhook ${event.id}`,
    });

    res.status(200).json({
      received: true,
      duplicate: result.replayed,
      transaction_id: result.transaction_id,
    });
  } catch (err) {
    next(err);
  }
};

router.post("/webhooks/payments", paymentWebhook);

export default router;
