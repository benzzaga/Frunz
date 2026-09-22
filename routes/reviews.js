import express from "express";
import { requireAuth } from "./auth.js";

const router = express.Router();

/**
 * POST /reviews  { dealId, rating, comment }
 * Как в FunPay: оставить отзыв может только покупатель, и только по сделке
 * в статусе 'confirmed' — так рейтинг нельзя накрутить без реальной сделки.
 */
router.post("/", requireAuth, async (req, res) => {
  const db = req.db;
  const { dealId, rating, comment } = req.body;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Оценка должна быть от 1 до 5." });
  }

  const { rows } = await db.query(`SELECT * FROM deals WHERE id = $1`, [dealId]);
  const deal = rows[0];
  if (!deal || deal.buyer_id !== req.userId) {
    return res.status(403).json({ error: "Оставить отзыв может только покупатель этой сделки." });
  }
  if (deal.status !== "confirmed") {
    return res.status(400).json({ error: "Отзыв доступен только после подтверждённой сделки." });
  }

  const exists = await db.query(`SELECT 1 FROM reviews WHERE deal_id = $1`, [dealId]);
  if (exists.rowCount > 0) return res.status(409).json({ error: "Отзыв по этой сделке уже оставлен." });

  await db.query(
    `INSERT INTO reviews (deal_id, author_id, target_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)`,
    [dealId, req.userId, deal.seller_id, rating, comment || null]
  );
  // rating_avg/rating_count у продавца пересчитываются триггером recalc_user_rating в БД

  res.status(201).json({ ok: true });
});

// POST /reviews/:id/reply  { text } — продавец отвечает на отзыв (как в FunPay)
router.post("/:id/reply", requireAuth, async (req, res) => {
  const db = req.db;
  const { rows } = await db.query(`SELECT * FROM reviews WHERE id = $1`, [req.params.id]);
  const review = rows[0];
  if (!review || review.target_id !== req.userId) return res.status(403).json({ error: "Недоступно." });

  await db.query(`UPDATE reviews SET seller_reply = $1 WHERE id = $2`, [req.body.text, review.id]);
  res.json({ ok: true });
});

// GET /reviews/user/:userId — публичный список отзывов профиля
router.get("/user/:userId", async (req, res) => {
  const db = req.db;
  const { rows } = await db.query(
    `SELECT r.rating, r.comment, r.seller_reply, r.created_at, u.username AS author_username
     FROM reviews r JOIN users u ON u.id = r.author_id
     WHERE r.target_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [req.params.userId]
  );
  res.json({ reviews: rows });
});

export { router as reviewsRouter };
