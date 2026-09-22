import express from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { validateUsername } from "../services/usernamePolicy.js";
import { issuePhoneOtp, confirmPhoneOtp } from "../services/phoneVerification.js";
import { issueEmailOtp, confirmEmailOtp } from "../services/emailVerification.js";

const router = express.Router();

// POST /auth/register  { username, password }
router.post("/register", async (req, res) => {
  const db = req.db;
  const { username, password } = req.body;

  const check = validateUsername(username || "");
  if (!check.ok) return res.status(400).json({ error: check.reason });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Пароль должен быть не короче 8 символов." });
  }

  const exists = await db.query(`SELECT 1 FROM users WHERE username = $1`, [username]);
  if (exists.rowCount > 0) return res.status(409).json({ error: "Ник уже занят." });

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`,
    [username, passwordHash]
  );
  const user = rows[0];

  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({ user, token });
});

// POST /auth/phone/request  { phone, country }  (требует auth)
router.post("/phone/request", requireAuth, async (req, res) => {
  const result = await issuePhoneOtp(req.db, req.userId, req.body.phone, req.body.country);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ sent: true, phone: result.e164 });
});

// POST /auth/phone/confirm  { code }
router.post("/phone/confirm", requireAuth, async (req, res) => {
  const result = await confirmPhoneOtp(req.db, req.userId, req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ verified: true });
});

// POST /auth/email/request  { email }
router.post("/email/request", requireAuth, async (req, res) => {
  const result = await issueEmailOtp(req.db, req.userId, req.body.email, "verify_email");
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ sent: true });
});

// POST /auth/email/confirm  { code }
router.post("/email/confirm", requireAuth, async (req, res) => {
  const result = await confirmEmailOtp(req.db, req.userId, req.body.code, "verify_email");
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ verified: true });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Требуется авторизация." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Недействительный токен." });
  }
}

export { router as authRouter, requireAuth };
