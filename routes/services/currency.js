/**
 * Конвертация валют.
 * Канонический номинал всех цен на сайте — USD (хранится в listings.price_usd).
 * Для отображения конвертируем в AMD / RUB / USDT / BTC / TRX по кэшированным курсам.
 */

// Источники курсов: фиат — например exchangerate.host или ЦБ РФ/ЦБ Армении для AMD/RUB,
// крипто — CoinGecko/Binance public API. Ниже — интерфейс обновления, дергается по крону.
async function fetchRatesFromProviders() {
  // TODO: реальные HTTP-запросы к провайдерам. Пример структуры результата:
  return {
    AMD: 405.0,      // 1 USD = ~405 AMD (ориентир, обновляется по крону, не хардкодить в проде)
    RUB: 92.0,
    USDT: 1.0,        // USDT ~ 1:1 к USD
    BTC: 0.000011,    // будет обновляться из реального курса
    TRX: 6.9,
  };
}

async function refreshExchangeRates(db) {
  const rates = await fetchRatesFromProviders();
  for (const [quote, rate] of Object.entries(rates)) {
    await db.query(
      `INSERT INTO exchange_rates (base, quote, rate)
       VALUES ('USD', $1, $2)
       ON CONFLICT (base, quote) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = now()`,
      [quote, rate]
    );
  }
}

async function getRate(db, quote) {
  const { rows } = await db.query(
    `SELECT rate FROM exchange_rates WHERE base = 'USD' AND quote = $1`,
    [quote]
  );
  if (!rows[0]) throw new Error(`Курс для ${quote} не найден — запустите refreshExchangeRates`);
  return Number(rows[0].rate);
}

/**
 * Отдаёт цену объявления сразу во всех витринных валютах,
 * чтобы продавец за 10 000 AMD видел эквивалент и в USD/RUB/USDT.
 */
async function priceInAllCurrencies(db, priceUsd) {
  const [amd, rub, usdt, btc, trx] = await Promise.all(
    ["AMD", "RUB", "USDT", "BTC", "TRX"].map((q) => getRate(db, q))
  );
  return {
    usd: round(priceUsd, 2),
    amd: round(priceUsd * amd, 0),
    rub: round(priceUsd * rub, 2),
    usdt: round(priceUsd * usdt, 4),
    btc: round(priceUsd * btc, 8),
    trx: round(priceUsd * trx, 4),
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Наценка (буфер) на пополнение баланса.
 * Задача: чтобы сетевые/биржевые комиссии при последующем выводе никогда не съедали
 * баланс площадки — на КАЖДОЕ пополнение удерживается фиксированный буфер (по умолчанию
 * $0.05-эквивалент в валюте пополнения), который зачисляется отдельно и покрывает будущие
 * комиссии, а не идёт пользователю на баланс.
 *
 * Для крупных монет (BTC) буфер не применяется в फик. сумме — используется свой порог,
 * заданный в DEPOSIT_MARGIN_OVERRIDES, потому что $0.05 в BTC — незначимая величина
 * относительно обычного размера комиссии сети.
 */
const DEFAULT_MARGIN_USD = 0.05;

const DEPOSIT_MARGIN_OVERRIDES = {
  BTC: 1.5, // BTC-комиссии сети выше — держим больший буфер в USD-эквиваленте
};

async function applyDepositMargin(db, currency, amountGross) {
  const marginUsd = DEPOSIT_MARGIN_OVERRIDES[currency] ?? DEFAULT_MARGIN_USD;

  let marginInCurrency;
  if (currency === "USDT_TRC20" || currency === "USDT") {
    marginInCurrency = marginUsd; // USDT ~ 1:1
  } else {
    const rate = await getRate(db, currency); // сколько currency за 1 USD
    marginInCurrency = marginUsd * rate;
  }

  const amountCredited = Math.max(0, amountGross - marginInCurrency);
  return {
    marginFee: round(marginInCurrency, 8),
    amountCredited: round(amountCredited, 8),
  };
}

export { refreshExchangeRates, getRate, priceInAllCurrencies, applyDepositMargin };
