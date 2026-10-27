import "./env";
import { readFileSync } from "fs";
import { join } from "path";
import { pool } from "../src/db";

async function main() {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  for (const file of ["schema.sql", "002_transfers.sql"]) {
    await pool.query(readFileSync(join(__dirname, "..", "db", file), "utf8"));
  }
  await pool.end();
  console.log("Test database ready");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
