import nodemailer from "nodemailer";
import crypto from "node:crypto";

// Работает с любым SMTP-провайдером (не только Gmail) — Mailgun, SendGrid,
// Yandex 360, собственный почтовый сервер и т.д. Настройки через .env.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// Базовая проверка формата — принимает любой валидный email-домен
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function issueEmailOtp(db, userId, email, purpose = "verify_email", dealId = null) {
  if (!EMAIL_RE.test(email)) {
    return { ok: false, reason: "Некорректный email." };
  }

  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await db.query(
    `INSERT INTO email_otp_codes (user_id, email, code_hash, purpose, related_deal_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, email, codeHash, purpose, dealId, expiresAt]
  );

  const subject =
    purpose === "confirm_purchase"
      ? "Код подтверждения покупки — fstore.am"
      : "Подтверждение email — fstore.am";

  await transporter.sendMail({
    from: process.env.MAIL_FROM || "fstore.am <no-reply@fstore.am>",
    to: email,
    subject,
    text: `Ваш код подтверждения: ${code}\nОн действителен 15 минут. Никому не сообщайте этот код.`,
  });

  return { ok: true };
}

async function confirmEmailOtp(db, userId, submittedCode, purpose = "verify_email") {
  const { rows } = await db.query(
    `SELECT * FROM email_otp_codes
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]
  );
  const record = rows[0];
  if (!record) return { ok: false, reason: "Код не запрашивался." };
  if (new Date(record.expires_at) < new Date()) return { ok: false, reason: "Код истёк." };
  if (record.attempts >= record.max_attempts) return { ok: false, reason: "Превышено число попыток." };

  if (hashOtp(submittedCode) !== record.code_hash) {
    await db.query(`UPDATE email_otp_codes SET attempts = attempts + 1 WHERE id = $1`, [record.id]);
    return { ok: false, reason: "Неверный код." };
  }

  await db.query(`UPDATE email_otp_codes SET consumed_at = now() WHERE id = $1`, [record.id]);

  if (purpose === "verify_email") {
    await db.query(`UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`, [record.email, userId]);
  } else if (purpose === "confirm_purchase" && record.related_deal_id) {
    await db.query(
      `UPDATE purchase_intents SET email_confirmed = TRUE WHERE deal_id = $1`,
      [record.related_deal_id]
    );
  }

  return { ok: true, dealId: record.related_deal_id };
}

export { issueEmailOtp, confirmEmailOtp };
