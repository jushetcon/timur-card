// Создаёт ссылку на счёт для оплаты звёздами Telegram (валюта XTR).
// Секрет бота берётся только из переменной окружения — на страницу не попадает.
var verifyTelegramInitData = require('./_lib/telegram').verifyTelegramInitData;

// Единственное место, где меняется цена — просто поменяй число.
// Для валюты XTR (звёзды) amount — это количество звёзд напрямую,
// без умножения на 100, как для обычных валют.
var STARS_PRICE = 50;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({
      ok: false,
      code: 'method_not_allowed',
      message: 'Неверный способ обращения к серверу.'
    });
    return;
  }

  var TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!TELEGRAM_BOT_TOKEN) {
    console.error('pay api: сервер не настроен — отсутствует TELEGRAM_BOT_TOKEN');
    res.status(500).json({
      ok: false,
      code: 'server_not_configured',
      message: 'Сервер настроен не полностью. Попробуй позже.'
    });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  body = body || {};

  var verifiedUser = verifyTelegramInitData(body.initData, TELEGRAM_BOT_TOKEN);
  if (!verifiedUser) {
    console.error('pay api: подпись initData не сошлась', {
      initDataLength: body.initData ? String(body.initData).length : 0
    });
    res.status(401).json({
      ok: false,
      code: 'invalid_signature',
      message: 'Не получилось подтвердить, что это ты. Попробуй переоткрыть приложение через Telegram.'
    });
    return;
  }

  var tgId = verifiedUser.id;

  try {
    var apiUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/createInvoiceLink';

    // payload попадёт обратно в апдейт successful_payment у бота —
    // пригодится, когда будем подтверждать оплату на сервере
    var payload = JSON.stringify({ tgId: tgId, ts: Date.now() });

    var r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Поддержать проект',
        description: 'Разовая поддержка приложения звёздами Telegram',
        payload: payload,
        provider_token: '', // для XTR провайдер не нужен — пустая строка
        currency: 'XTR',
        prices: [{ label: 'Поддержать', amount: STARS_PRICE }]
      })
    });

    var json = await r.json();

    if (!r.ok || !json.ok) {
      console.error('pay api: Telegram createInvoiceLink вернул ошибку', { status: r.status, body: json });
      res.status(502).json({
        ok: false,
        code: 'telegram_unreachable',
        message: 'Не получилось создать счёт. Попробуй ещё раз.'
      });
      return;
    }

    res.status(200).json({ ok: true, link: json.result });
  } catch (e) {
    console.error('pay api: не удалось обратиться к Telegram Bot API (tg_id=' + tgId + ')', e);
    res.status(502).json({
      ok: false,
      code: 'telegram_unreachable',
      message: 'Не получилось создать счёт. Попробуй ещё раз.'
    });
  }
};
