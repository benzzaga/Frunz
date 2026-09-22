import "dotenv/config";
import express from "express";
import pg from "pg";
import cron from "node-cron";
import cors from "cors";

import { authRouter } from "./routes/auth.js";
import { listingsRouter } from "./routes/listings.js";
import { dealsRouter } from "./routes/deals.js";
import { reviewsRouter } from "./routes/reviews.js";
import { profileRouter } from "./routes/profile.js";
import { refreshExchangeRates } from "./services/currency.js";
import { pollTronDeposits } from "./services/tronListener.js";

// 1. Создаем приложение express
const app = express();

// 2. Подключаем Middleware (CORS строго ДО роутов)
app.use(cors());
app.use(express.json());

// 3. Подключение к базе данных
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
app.use((req, _res, next) => {
  req.db = db;
  next();
});

// 4. Главная страница (чтобы не было "Cannot GET /")
app.get("/", (_req, res) => {
  res.send("fstore backend работает отлично!");
});

// 5. Проверка здоровья сервера
app.get("/health", (_req, res) => res.json({ ok: true }));

// 6. Подключение основных маршрутов (поддерживаем оба варианта: с /api и без)
app.use("/auth", authRouter);
app.use("/listings", listingsRouter);
app.use("/deals", dealsRouter);
app.use("/reviews", reviewsRouter);
app.use("/profile", profileRouter);

app.use("/api/auth", authRouter);
app.use("/api/listings", listingsRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/profile", profileRouter);

// 7. Фоновые задачи (Cron)
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
    const lastCheckedMs = existing[0]?.checkpoint_ms || Date.now() - 60_000;

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

// 8. Единый обработчик ошибок
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

// 9. Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`fstore backend запущен на порту ${PORT}`));
