import { parsePhoneNumberFromString } from "libphonenumber-js";
import crypto from "node:crypto";

// Поддерживаемые страны СНГ (ISO2)
const SUPPORTED_COUNTRIES = ["AM", "RU", "KZ", "BY", "UZ", "KG", "TJ", "MD", "AZ", "GE"];

function normalizePhone(rawInput, defaultCountry) {
  const phone = parsePhoneNumberFromString(rawInput, defaultCountry);
  if (!phone || !phone.isValid()) {
    return { ok: false, reason: "Некорректный номер телефона." };
  }
  if (!SUPPORTED_COUNTRIES.includes(phone.country)) {
    return { ok: false, reason: "Поддерживаются только номера стран СНГ (AM, RU, KZ, BY, UZ, KG, TJ, MD, AZ, GE)." };
  }
  return { ok: true, e164: phone.number, country: phone.country };
}

function generateOtp() {
  // 6-значный код
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Отправка SMS — подключается провайдер СМС для СНГ (например SMS.ru, Beeline SMS API,
 * или локальный армянский агрегатор). Ниже — интерфейс, который нужно реализовать под
 * выбранного провайдера; сам текст сообщения uses local formatting.
 */
async function sendSms(e164, code) {
  // TODO: подставить реального провайдера. Пример структуры вызова:
  // await smsProviderClient.send({ to: e164, text: `fstore.am: ваш код подтверждения ${code}. Никому не сообщайте его.` });
  console.log(`[SMS→${e164}] код подтверждения: ${code}`);
}

async function issuePhoneOtp(db, userId, rawPhone, defaultCountry) {
  const parsed = normalizePhone(rawPhone, defaultCountry);
  if (!parsed.ok) return parsed;

  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 минут

  await db.query(
    `INSERT INTO phone_otp_codes (user_id, phone_e164, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, parsed.e164, codeHash, expiresAt]
  );

  await sendSms(parsed.e164, code);

  return { ok: true, e164: parsed.e164, country: parsed.country };
}

async function confirmPhoneOtp(db, userId, submittedCode) {
  const { rows } = await db.query(
    `SELECT * FROM phone_otp_codes
     WHERE user_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const record = rows[0];
  if (!record) return { ok: false, reason: "Код не запрашивался." };
  if (new Date(record.expires_at) < new Date()) return { ok: false, reason: "Код истёк." };
  if (record.attempts >= record.max_attempts) return { ok: false, reason: "Превышено число попыток." };

  const submittedHash = hashOtp(submittedCode);
  if (submittedHash !== record.code_hash) {
    await db.query(`UPDATE phone_otp_codes SET attempts = attempts + 1 WHERE id = $1`, [record.id]);
    return { ok: false, reason: "Неверный код." };
  }

  await db.query(`UPDATE phone_otp_codes SET consumed_at = now() WHERE id = $1`, [record.id]);
  await db.query(
    `UPDATE users SET phone_e164 = $1, phone_country = $2, phone_verified_at = now() WHERE id = $3`,
    [record.phone_e164, record.phone_country ?? null, userId]
  );

  return { ok: true };
}

export { normalizePhone, issuePhoneOtp, confirmPhoneOtp, SUPPORTED_COUNTRIES };
