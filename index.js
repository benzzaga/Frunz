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

// 1. Инициализация Express
const app = express();

// 2. Расширенная настройка CORS (строго до роутов)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Парсинг JSON-тел запросов
app.use(express.json());

// 3. Подключение к базовому пулу PostgreSQL
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
app.use((req, _res, next) => {
  req.db = db;
  next();
});

// 4. Проверка работы сервера
app.get("/", (_req, res) => {
  res.send("fstore backend работает отлично!");
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// 5. Маршруты API (с поддержкой обособленных и префиксных путей)
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

// 6. Фоновые Cron-задачи
cron.schedule("*/5 * * * *", () => {
  refreshExchangeRates(db).catch((err) => console.error("Ошибка обновления курсов:", err));
});
refreshExchangeRates(db).catch((err) => console.error("Ошибка обновления курсов:", err));

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

// 7. Обработка несуществующих маршрутов (404)
app.use((_req, res) => {
  res.status(404).json({ error: "Маршрут не найден" });
});

// 8. Глобальный обработчик ошибок (500)
app.use((err, _req, res, _next) => {
  console.error("Глобальная ошибка сервера:", err);
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

// 9. Старт сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`fstore backend запущен на порту ${PORT}`));
