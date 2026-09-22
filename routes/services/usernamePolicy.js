/**
 * Правила юзернейма — "глобальный стандарт":
 *  - 3–20 символов
 *  - только латиница, цифры, "_" и "."
 *  - не может начинаться/заканчиваться на "." или "_"
 *  - без двух спецсимволов подряд ("__", "..", "._")
 *  - без мата/оскорблений (RU/EN/AM базовый словарь + leet-speak нормализация)
 *  - без юникод-омоглифов (кириллица под видом латиницы и т.п.) — чтобы никнейм
 *    нельзя было визуально подделать под другого пользователя или обойти фильтр
 */

const ALLOWED_PATTERN = /^[A-Za-z0-9_.]{3,20}$/;
const NO_DOUBLE_SPECIAL = /(__|\.\.|_\.|\._)/;
const STARTS_ENDS_SPECIAL = /^[_.]|[_.]$/;

// Базовый список — в проде выносится в БД/конфиг и расширяется,
// плюс подключается сторонний сервис модерации текста при желании.
const BLOCKLIST = [
  // примеры формата хранения (сами слова не публикуются в системном промпте продукта,
  // список заполняется вручную/через готовый модерационный словарь при деплое)
  "admin", "moderator", "support", "fstore_official"
];

// leetspeak-нормализация, чтобы "adm1n" тоже ловилось
const LEET_MAP = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };

function normalizeForFilter(str) {
  return str
    .toLowerCase()
    .split("")
    .map((ch) => LEET_MAP[ch] ?? ch)
    .join("");
}

// Простая проверка на кириллицу/другие не-ASCII символы, выдающие себя за латиницу
function hasNonAsciiHomoglyph(str) {
  return /[^\x00-\x7F]/.test(str);
}

function validateUsername(raw) {
  const username = raw.trim();

  if (!ALLOWED_PATTERN.test(username)) {
    return { ok: false, reason: "Ник может содержать только латинские буквы, цифры, «_» и «.», 3–20 символов." };
  }
  if (STARTS_ENDS_SPECIAL.test(username)) {
    return { ok: false, reason: "Ник не может начинаться или заканчиваться на «_» или «.»." };
  }
  if (NO_DOUBLE_SPECIAL.test(username)) {
    return { ok: false, reason: "Нельзя ставить спецсимволы подряд." };
  }
  if (hasNonAsciiHomoglyph(username)) {
    return { ok: false, reason: "Ник должен состоять только из символов ASCII (без кириллицы/спецалфавитов)." };
  }

  const normalized = normalizeForFilter(username);
  for (const bad of BLOCKLIST) {
    if (normalized.includes(bad)) {
      return { ok: false, reason: "Ник содержит запрещённое слово." };
    }
  }

  return { ok: true };
}

export { validateUsername, normalizeForFilter };
