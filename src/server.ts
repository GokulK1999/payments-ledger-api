import app from "./app";

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Ledger API listening on http://localhost:${PORT}`);
});
