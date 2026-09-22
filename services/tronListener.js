/**
 * Блокчейн-слушатель USDT (TRC-20, сеть TRON).
 *
 * Как это устроено:
 *  - У площадки есть один центральный кошелёк, куда фактически приходят все USDT.
 *  - Каждому пользователю при первом пополнении выдаётся не отдельный TRON-адрес
 *    (это дорого и избыточно для TRC-20), а уникальный MEMO/ID платежа, который
 *    он обязан указать при переводе — либо ему показывается предрасчитанная сумма
 *    "до копейки" (см. paymentMatcher), по которой мы опознаём, чья это оплата,
 *    даже без memo (TRON не поддерживает memo как в TON/XRP).
 *  - Слушатель раз в N секунд опрашивает TronGrid API на предмет новых входящих
 *    транзакций USDT на центральный адрес, сверяет сумму с ожидаемыми депозитами
 *    и открытыми сделками, и при совпадении зачисляет средства.
 *
 * ВАЖНО: приватный ключ центрального кошелька здесь не участвует (слушатель только
 * ЧИТАЕТ блокчейн). Ключ нужен только сервису вывода средств (withdrawals) — его
 * стоит держать отдельно и максимально изолированно от остального бэкенда.
 */

const TRON_API = "https://api.trongrid.io";
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // официальный контракт USDT на TRON
const CENTRAL_WALLET_ADDRESS = process.env.TRON_CENTRAL_WALLET; // задаётся в .env

async function fetchIncomingUsdtTransfers(sinceTimestampMs) {
  const url =
    `${TRON_API}/v1/accounts/${CENTRAL_WALLET_ADDRESS}/transactions/trc20` +
    `?limit=50&contract_address=${USDT_TRC20_CONTRACT}&only_confirmed=true` +
    `&min_timestamp=${sinceTimestampMs}`;

  const headers = process.env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY } : {};
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`TronGrid ответил ${resp.status}`);
  const data = await resp.json();

  return (data.data || [])
    .filter((tx) => tx.to === CENTRAL_WALLET_ADDRESS)
    .map((tx) => ({
      txHash: tx.transaction_id,
      fromAddress: tx.from,
      amountRaw: BigInt(tx.value),          // в минимальных единицах (USDT = 6 знаков после запятой)
      amount: Number(tx.value) / 1_000_000,  // человекочитаемая сумма
      timestampMs: tx.block_timestamp,
    }));
}

/**
 * Сопоставление входящего платежа с ожидаемой сделкой.
 * Раз TRC-20 не даёт memo, используется приём "уникальная копеечная сумма":
 * при создании ожидания оплаты к сумме сделки добавляется небольшой случайный
 * довесок (например +0.0007 USDT), уникальный в пределах открытого окна,
 * чтобы отличить разные ожидающие платежи друг от друга даже при одинаковой цене.
 */
async function matchAndProcessDeposit(db, transfer) {
  const { rows } = await db.query(
    `SELECT * FROM deals WHERE status = 'awaiting_payment' AND currency = 'USDT_TRC20'
       AND amount_paid = $1
     ORDER BY created_at ASC LIMIT 1`,
    [transfer.amount]
  );
  const deal = rows[0];
  if (!deal) return { matched: false, txHash: transfer.txHash };

  const already = await db.query(`SELECT 1 FROM deposits WHERE tx_hash = $1`, [transfer.txHash]);
  if (already.rowCount > 0) return { matched: false, reason: "already_processed" };

  const { applyDepositMargin } = await import("./currency.js");
  const { marginFee, amountCredited } = await applyDepositMargin(db, "USDT_TRC20", transfer.amount);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const wallet = await client.query(
      `INSERT INTO wallets (user_id, currency, deposit_address)
       VALUES ($1, 'USDT_TRC20', $2)
       ON CONFLICT (user_id, currency) DO UPDATE SET currency = EXCLUDED.currency
       RETURNING id`,
      [deal.buyer_id, CENTRAL_WALLET_ADDRESS]
    );

    await client.query(
      `INSERT INTO deposits (wallet_id, tx_hash, amount_gross, margin_fee, amount_credited, confirmations, status)
       VALUES ($1, $2, $3, $4, $5, 20, 'credited')`,
      [wallet.rows[0].id, transfer.txHash, transfer.amount, marginFee, amountCredited]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Помечаем саму сделку оплаченной — переиспользуем ручку из routes/deals.js через прямой SQL,
  // чтобы не тянуть Express-роутер внутрь фонового воркера.
  await db.query(
    `UPDATE deals SET status = 'held', updated_at = now() WHERE id = $1`,
    [deal.id]
  );
  await db.query(
    `INSERT INTO wallets (user_id, currency, deposit_address, held_balance)
     VALUES ($1, 'USDT_TRC20', $2, $3)
     ON CONFLICT (user_id, currency) DO UPDATE SET held_balance = wallets.held_balance + EXCLUDED.held_balance`,
    [deal.seller_id, CENTRAL_WALLET_ADDRESS, deal.amount_paid]
  );
  await db.query(
    `INSERT INTO audit_log (actor_role, action, entity_type, entity_id, metadata)
     VALUES ('system', 'deal.paid.onchain', 'deal', $1, $2)`,
    [deal.id, JSON.stringify({ txHash: transfer.txHash, amount: transfer.amount })]
  );

  return { matched: true, dealId: deal.id, txHash: transfer.txHash };
}

/**
 * Основной цикл — запускается по крону раз в 30-60 секунд.
 * Хранит "с какого момента смотреть дальше" в отдельной служебной таблице/переменной,
 * чтобы не пересканировать всю историю при каждом запуске.
 */
async function pollTronDeposits(db, lastCheckedMs) {
  const transfers = await fetchIncomingUsdtTransfers(lastCheckedMs);
  const results = [];
  for (const transfer of transfers) {
    results.push(await matchAndProcessDeposit(db, transfer));
  }
  const newCheckpoint = transfers.length
    ? Math.max(...transfers.map((t) => t.timestampMs))
    : lastCheckedMs;
  return { results, newCheckpoint };
}

export { pollTronDeposits, fetchIncomingUsdtTransfers, matchAndProcessDeposit };
