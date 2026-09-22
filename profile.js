import express from "express";
import { requireAuth } from "./auth.js";
import { validateUsername } from "../services/usernamePolicy.js";

const router = express.Router();

// GET /profile/:username — публичная карточка (без email/телефона — только то, что нужно видеть другим)
router.get("/:username", async (req, res) => {
  const db = req.db;
  const { rows } = await db.query(
    `SELECT id, username, avatar_url, bio, rating_avg, rating_count, deals_count,
            (phone_verified_at IS NOT NULL) AS phone_verified,
            created_at
     FROM users WHERE username = $1 AND is_banned = FALSE`,
    [req.params.username]
  );
  if (!rows[0]) return res.status(404).json({ error: "Профиль не найден." });
  res.json({ profile: rows[0] });
});

// PATCH /profile/me  { avatarUrl, bio, username? }
router.patch("/me", requireAuth, async (req, res) => {
  const db = req.db;
  const { avatarUrl, bio, username } = req.body;

  if (username) {
    const check = validateUsername(username);
    if (!check.ok) return res.status(400).json({ error: check.reason });
    const taken = await db.query(`SELECT 1 FROM users WHERE username = $1 AND id != $2`, [username, req.userId]);
    if (taken.rowCount > 0) return res.status(409).json({ error: "Ник уже занят." });
  }

  const { rows } = await db.query(
    `UPDATE users SET
        avatar_url = COALESCE($1, avatar_url),
        bio = COALESCE($2, bio),
        username = COALESCE($3, username),
        updated_at = now()
     WHERE id = $4
     RETURNING id, username, avatar_url, bio`,
    [avatarUrl || null, bio || null, username || null, req.userId]
  );
  res.json({ profile: rows[0] });
});

export { router as profileRouter };
