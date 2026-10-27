// Import this first in every test file. It points the tests at a separate
// test database, so they can never touch your real data.
process.env.DATABASE_URL ??= "postgres://localhost:5432/ledger_test";
if (!process.env.DATABASE_URL.includes("_test")) {
  throw new Error("Refusing to run tests: DATABASE_URL must point to a database whose name contains _test");
}
// Secret used to sign test webhooks.
process.env.WEBHOOK_SECRET ??= "test-webhook-secret";
export {};
