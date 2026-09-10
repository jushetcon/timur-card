// Создаёт ссылку на счёт для оплаты звёздами Telegram (валюта XTR)
// и позволяет странице проверить, появился ли уже доступ после оплаты.
// Секрет бота и база — только из переменных окружения, на страницу не попадают.
var verifyTelegramInitData = require('./_lib/telegram').verifyTelegramInitData;

// Единственное место, где меняется цена — просто поменяй число.
// Для валюты XTR (звёзды) amount — это количество звёзд напрямую,
// без умножения на 100, как для обычных валют.
var STARS_PRICE = 50;

async function hasPaid(supabaseUrl, serviceKey, tgId) {
  var url = supabaseUrl + '/rest/v1/payments?tg_id=eq.' + tgId + '&select=charge_id&limit=1';
  var r = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey
    }
  });
  if (!r.ok) {
    var errText = await r.text().catch(function () { return '(тело ответа не читается)'; });
    throw new Error('Supabase payments read failed: HTTP ' + r.status + ' — ' + errText);
  }
  var rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

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
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('pay api: сервер не настроен — отсутствует одна из переменных окружения');
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
      action: body.action,
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
  var action = body.action || 'create_invoice';

  if (action === 'status') {
    try {
      var hasAccess = await hasPaid(SUPABASE_URL, SUPABASE_SERVICE_KEY, tgId);
      res.status(200).json({ ok: true, hasAccess: hasAccess });
    } catch (e) {
      console.error('pay api: не удалось проверить доступ (tg_id=' + tgId + ')', e);
      res.status(502).json({
        ok: false,
        code: 'database_unreachable',
        message: 'Не получилось проверить доступ. Попробуем ещё раз.'
      });
    }
    return;
  }

  try {
    var apiUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/createInvoiceLink';

    // payload попадёт обратно в апдейт successful_payment у бота — но доступ
    // при оплате открываем не по нему, а по тому, кто реально прислал апдейт
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
