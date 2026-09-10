// Принимает апдейты от Telegram: подтверждение платежа (pre_checkout_query)
// и уведомление об успешной оплате (message.successful_payment).
// Вызывается САМИМ Telegram (не страницей) — настраивается один раз через
// метод Bot API setWebhook. Подлинность проверяем секретным токеном
// (заголовок X-Telegram-Bot-Api-Secret-Token), который Telegram присылает
// обратно ровно таким, каким его задали при setWebhook — без него кто угодно
// мог бы прислать поддельное "оплата прошла" и получить доступ бесплатно.

async function answerPreCheckout(botToken, preCheckoutQueryId) {
  var r = await fetch('https://api.telegram.org/bot' + botToken + '/answerPreCheckoutQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pre_checkout_query_id: preCheckoutQueryId, ok: true })
  });
  if (!r.ok) {
    var errText = await r.text().catch(function () { return '(тело ответа не читается)'; });
    throw new Error('answerPreCheckoutQuery failed: HTTP ' + r.status + ' — ' + errText);
  }
}

async function recordPayment(supabaseUrl, serviceKey, payment) {
  var url = supabaseUrl + '/rest/v1/payments?on_conflict=charge_id';
  var r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      // ignore-duplicates: если этот charge_id уже записан (Telegram прислал
      // уведомление повторно), вставка молча пропускается — не ошибка
      Prefer: 'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify([{
      charge_id: payment.chargeId,
      tg_id: payment.tgId,
      amount: payment.amount,
      payload: payment.payload
    }])
  });

  if (!r.ok) {
    var errText = await r.text().catch(function () { return '(тело ответа не читается)'; });
    throw new Error('Supabase payments insert failed: HTTP ' + r.status + ' — ' + errText);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  var TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  var TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('telegram-webhook: сервер не настроен — отсутствует одна из переменных окружения', {
      hasBotToken: !!TELEGRAM_BOT_TOKEN,
      hasWebhookSecret: !!TELEGRAM_WEBHOOK_SECRET,
      hasSupabaseUrl: !!SUPABASE_URL,
      hasServiceKey: !!SUPABASE_SERVICE_KEY
    });
    res.status(200).json({ ok: true }); // отвечаем 200, чтобы Telegram не долбил повторами; проблема — в логах
    return;
  }

  var incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (incomingSecret !== TELEGRAM_WEBHOOK_SECRET) {
    console.error('telegram-webhook: неверный secret token — запрос не похож на настоящий от Telegram');
    res.status(401).json({ ok: false });
    return;
  }

  var update = req.body;
  if (typeof update === 'string') {
    try { update = JSON.parse(update); } catch (e) { update = null; }
  }
  update = update || {};

  // 1) подтверждение платежа — обязаны ответить за 10 секунд, без базы
  if (update.pre_checkout_query) {
    try {
      await answerPreCheckout(TELEGRAM_BOT_TOKEN, update.pre_checkout_query.id);
    } catch (e) {
      console.error('telegram-webhook: не удалось ответить на pre_checkout_query — платёж будет отменён Telegram по таймауту', e);
    }
    res.status(200).json({ ok: true });
    return;
  }

  // 2) уведомление об успешной оплате — записываем и открываем доступ
  var payment = update.message && update.message.successful_payment;
  if (payment) {
    // доступ открываем тому, от кого пришло уведомление, а не тому, кто
    // указан в payload счёта
    var payerTgId = update.message.from && update.message.from.id;

    if (typeof payerTgId !== 'number') {
      console.error('telegram-webhook: в successful_payment нет message.from.id — доступ не открыт', update);
      res.status(200).json({ ok: true });
      return;
    }

    try {
      await recordPayment(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        chargeId: payment.telegram_payment_charge_id,
        tgId: payerTgId,
        amount: payment.total_amount,
        payload: payment.invoice_payload
      });
    } catch (e) {
      // молчать здесь нельзя: человек заплатил, а мы могли не записать это
      console.error('telegram-webhook: не удалось записать платёж (charge_id=' + payment.telegram_payment_charge_id + ', tg_id=' + payerTgId + ')', e);
    }

    res.status(200).json({ ok: true });
    return;
  }

  // остальные типы апдейтов нас не интересуют — просто подтверждаем получение
  res.status(200).json({ ok: true });
};
