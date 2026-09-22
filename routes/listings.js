import express from "express";
import { requireAuth } from "./auth.js";
import { priceInAllCurrencies } from "../services/currency.js";

const router = express.Router();

// GET /listings?category=game-accounts — витрина с ценой во всех валютах сразу
router.get("/", async (req, res) => {
  const db = req.db;
  const { category } = req.query;

  const { rows } = await db.query(
    `SELECT l.*, u.username AS seller_username, u.rating_avg, u.rating_count, u.deals_count
     FROM listings l
     JOIN users u ON u.id = l.seller_id
     JOIN categories c ON c.id = l.category_id
     WHERE l.status = 'active' AND ($1::text IS NULL OR c.slug = $1)
     ORDER BY l.created_at DESC LIMIT 60`,
    [category || null]
  );

  const withPrices = await Promise.all(
    rows.map(async (listing) => ({
      ...listing,
      prices: await priceInAllCurrencies(db, Number(listing.price_usd)),
    }))
  );

  res.json({ listings: withPrices });
});

// POST /listings  { categoryId, title, description, priceUsd, stock }
// Требует подтверждённый телефон — как и покупка, площадка не пускает непроверенные
// профили продавать, чтобы репутационная система (отзывы) была надёжной.
router.post("/", requireAuth, async (req, res) => {
  const db = req.db;
  const { rows: userRows } = await db.query(`SELECT phone_verified_at FROM users WHERE id = $1`, [req.userId]);
  if (!userRows[0].phone_verified_at) {
    return res.status(403).json({ error: "Подтвердите номер телефона перед публикацией объявлений." });
  }

  const { categoryId, title, description, priceUsd, stock } = req.body;
  if (!title || !description || !(priceUsd > 0)) {
    return res.status(400).json({ error: "Заполните title, description и priceUsd." });
  }

  const { rows } = await db.query(
    `INSERT INTO listings (seller_id, category_id, title, description, price_usd, stock)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.userId, categoryId, title, description, priceUsd, stock || 1]
  );
  res.status(201).json({ listing: rows[0] });
});

export { router as listingsRouter };
