import "dotenv/config";
import express from "express";
import pg from "pg";
import cron from "node-cron";

import { authRouter } from "./routes/auth.js";
import { listingsRouter } from "./routes/listings.js";
import { dealsRouter } from "./routes/deals.js";
import { reviewsRouter } from "./routes/reviews.js";
import { profileRouter } from "./routes/profile.js";
import { refreshExchangeRates } from "./services/currency.js";
import { pollTronDeposits } from "./services/tronListener.js";

const app = express();
app.use(express.json());

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
app.use((req, _res, next) => {
  req.db = db;
  next();
});

app.use("/auth", authRouter);
app.use("/listings", listingsRouter);
app.use("/deals", dealsRouter);
app.use("/reviews", reviewsRouter);
app.use("/profile", profileRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Курсы валют обновляются каждые 5 минут
cron.schedule("*/5 * * * *", () => {
  refreshExchangeRates(db).catch((err) => console.error("Ошибка обновления курсов:", err));
});
refreshExchangeRates(db).catch((err) => console.error("Ошибка обновления курсов:", err));

// Блокчейн-слушатель USDT (TRC-20) — проверяет новые поступления каждые 30 секунд
cron.schedule("*/30 * * * * *", async () => {
  try {
    const { rows } = await db.query(
      `INSERT INTO worker_checkpoints (worker_name, checkpoint_ms)
       VALUES ('tron_usdt', $1)
       ON CONFLICT (worker_name) DO NOTHING
       RETURNING checkpoint_ms`,
      [Date.now() - 60_000]
    );
    const { rows: existing } = await db.query(
      `SELECT checkpoint_ms FROM worker_checkpoints WHERE worker_name = 'tron_usdt'`
    );
    const lastCheckedMs = existing[0].checkpoint_ms;

    const { results, newCheckpoint } = await pollTronDeposits(db, lastCheckedMs);
    await db.query(
      `UPDATE worker_checkpoints SET checkpoint_ms = $1, updated_at = now() WHERE worker_name = 'tron_usdt'`,
      [newCheckpoint]
    );
    const matched = results.filter((r) => r.matched);
    if (matched.length) console.log(`Зачислено сделок по USDT: ${matched.length}`);
  } catch (err) {
    console.error("Ошибка слушателя TRON:", err);
  }
});

// Единый обработчик ошибок — чтобы не ронять процесс и не светить стектрейсы наружу
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`fstore backend запущен на порту ${PORT}`));
