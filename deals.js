import express from "express";
import { requireAuth } from "./auth.js";
import { issueEmailOtp, confirmEmailOtp } from "../services/emailVerification.js";

const router = express.Router();

/**
 * POST /deals  { listingId }
 * Создаёт сделку в статусе awaiting_payment и требует подтверждения email покупателя
 * ПЕРЕД тем, как показать реквизиты для оплаты — это тот самый шаг "код пришёл на почту,
 * подтвердил — можно платить".
 */
router.post("/", requireAuth, async (req, res) => {
  const db = req.db;
  const { listingId } = req.body;

  const { rows: listingRows } = await db.query(
    `SELECT * FROM listings WHERE id = $1 AND status = 'active'`,
    [listingId]
  );
  const listing = listingRows[0];
  if (!listing) return res.status(404).json({ error: "Объявление не найдено." });
  if (listing.seller_id === req.userId) {
    return res.status(400).json({ error: "Нельзя купить собственное объявление." });
  }

  const { rows: userRows } = await db.query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [req.userId]);
  const buyer = userRows[0];

  const { rows: dealRows } = await db.query(
    `INSERT INTO deals (listing_id, buyer_id, seller_id, price_usd, currency, amount_paid, status)
     VALUES ($1, $2, $3, $4, 'USDT_TRC20', 0, 'awaiting_payment') RETURNING *`,
    [listing.id, req.userId, listing.seller_id, listing.price_usd]
  );
  const deal = dealRows[0];
  await db.query(`INSERT INTO purchase_intents (deal_id) VALUES ($1)`, [deal.id]);

  // Если email ещё не подтверждён вообще — шлём код сразу, привязанный к этой сделке
  if (!buyer.email_verified_at) {
    return res.status(202).json({
      deal,
      requiresEmailVerification: true,
      message: "Подтвердите email перед оплатой — введите ваш email.",
    });
  }

  await logAudit(db, req.userId, "deal.created", "deal", deal.id, { listingId });
  res.status(201).json({ deal, requiresEmailVerification: false });
});

// POST /deals/:id/confirm-email  { email? , code? }  — двухшаговый: сначала email, потом code
router.post("/:id/confirm-email", requireAuth, async (req, res) => {
  const db = req.db;
  const { email, code } = req.body;

  if (code) {
    const result = await confirmEmailOtp(db, req.userId, code, "confirm_purchase");
    if (!result.ok) return res.status(400).json({ error: result.reason });
    return res.json({ emailConfirmed: true });
  }
  if (email) {
    const result = await issueEmailOtp(db, req.userId, email, "confirm_purchase", req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.reason });
    return res.json({ sent: true });
  }
  res.status(400).json({ error: "Передайте email или code." });
});

/**
 * POST /deals/:id/mark-paid
 * Вызывается вебхуком блокчейн-слушателя (не напрямую пользователем) после того,
 * как на кастодиальный кошелёк площадки пришла сумма сделки.
 * Переводит средства в held_balance продавца — они видны, но недоступны к выводу.
 */
router.post("/:id/mark-paid", async (req, res) => {
  const db = req.db;
  const { amountPaid, currency } = req.body; // приходит от внутреннего сервиса-слушателя блокчейна

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const deal = rows[0];
    if (!deal || deal.status !== "awaiting_payment") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Сделка не в статусе ожидания оплаты." });
    }

    await client.query(
      `UPDATE deals SET status = 'held', amount_paid = $1, currency = $2, updated_at = now() WHERE id = $3`,
      [amountPaid, currency, deal.id]
    );

    // Зачисляем в held_balance продавца (создаём кошелёк, если ещё нет)
    await client.query(
      `INSERT INTO wallets (user_id, currency, deposit_address, held_balance)
       VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (user_id, currency)
       DO UPDATE SET held_balance = wallets.held_balance + EXCLUDED.held_balance`,
      [deal.seller_id, currency, amountPaid]
    );

    await client.query(
      `INSERT INTO audit_log (actor_role, action, entity_type, entity_id, metadata)
       VALUES ('system', 'deal.paid', 'deal', $1, $2)`,
      [deal.id, JSON.stringify({ amountPaid, currency })]
    );

    await client.query("COMMIT");
    res.json({ status: "held" });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// POST /deals/:id/deliver — продавец отмечает, что передал товар/доступ
router.post("/:id/deliver", requireAuth, async (req, res) => {
  const db = req.db;
  const { rows } = await db.query(`SELECT * FROM deals WHERE id = $1`, [req.params.id]);
  const deal = rows[0];
  if (!deal || deal.seller_id !== req.userId) return res.status(403).json({ error: "Недоступно." });
  if (deal.status !== "held") return res.status(400).json({ error: "Сделка не оплачена." });

  const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 дня на авто-подтверждение
  await db.query(
    `UPDATE deals SET status = 'delivered', delivered_at = now(), confirm_deadline = $1, updated_at = now() WHERE id = $2`,
    [deadline, deal.id]
  );
  await logAudit(db, req.userId, "deal.delivered", "deal", deal.id, {});
  res.json({ status: "delivered", confirmDeadline: deadline });
});

/**
 * POST /deals/:id/confirm — покупатель подтверждает получение.
 * Переводит held_balance продавца в available_balance — вот сам момент "разморозки".
 */
router.post("/:id/confirm", requireAuth, async (req, res) => {
  const db = req.db;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const deal = rows[0];
    if (!deal || deal.buyer_id !== req.userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Недоступно." });
    }
    if (!["delivered", "held"].includes(deal.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Сделку нельзя подтвердить в текущем статусе." });
    }

    await client.query(
      `UPDATE deals SET status = 'confirmed', confirmed_at = now(), updated_at = now() WHERE id = $1`,
      [deal.id]
    );
    await client.query(
      `UPDATE wallets SET held_balance = held_balance - $1, available_balance = available_balance + $1
       WHERE user_id = $2 AND currency = $3`,
      [deal.amount_paid, deal.seller_id, deal.currency]
    );
    await client.query(`UPDATE users SET deals_count = deals_count + 1 WHERE id IN ($1, $2)`, [
      deal.buyer_id,
      deal.seller_id,
    ]);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id)
       VALUES ($1, 'deal.confirmed', 'deal', $2)`,
      [req.userId, deal.id]
    );

    await client.query("COMMIT");
    res.json({ status: "confirmed" });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// POST /deals/:id/dispute  { reason }
router.post("/:id/dispute", requireAuth, async (req, res) => {
  const db = req.db;
  const { rows } = await db.query(`SELECT * FROM deals WHERE id = $1`, [req.params.id]);
  const deal = rows[0];
  if (!deal || ![deal.buyer_id, deal.seller_id].includes(req.userId)) {
    return res.status(403).json({ error: "Недоступно." });
  }
  await db.query(`UPDATE deals SET status = 'disputed', updated_at = now() WHERE id = $1`, [deal.id]);
  await db.query(`INSERT INTO disputes (deal_id, opened_by, reason) VALUES ($1, $2, $3)`, [
    deal.id,
    req.userId,
    req.body.reason || "",
  ]);
  res.json({ status: "disputed" });
});

async function logAudit(db, actorId, action, entityType, entityId, metadata) {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, entityType, entityId, JSON.stringify(metadata)]
  );
}

export { router as dealsRouter };
