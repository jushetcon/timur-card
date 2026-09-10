// Серверная функция-посредник между страницей и базой Supabase.
// Выполняется на сервере Vercel — секреты берутся только из переменных
// окружения и никогда не уходят в код страницы.
//
// Каждый ответ клиенту содержит короткое человеческое сообщение (message) —
// его можно показывать прямо на экране. Полная техническая причина (status,
// тело ответа Supabase, стек ошибки) всегда пишется через console.error —
// её видно в логах функции на Vercel (Vercel Dashboard → проект → Logs, или
// `vercel logs`), но никогда не уходит клиенту.
var verifyTelegramInitData = require('./_lib/telegram').verifyTelegramInitData;

async function readHabits(supabaseUrl, serviceKey, tgId) {
  var url = supabaseUrl + '/rest/v1/habits?tg_id=eq.' + tgId + '&select=data&limit=1';
  var r = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey
    }
  });
  if (!r.ok) {
    var errText = await r.text().catch(function () { return '(тело ответа не читается)'; });
    throw new Error('Supabase read failed: HTTP ' + r.status + ' — ' + errText);
  }
  var rows = await r.json();
  return rows && rows[0] ? rows[0].data : null;
}

async function writeHabits(supabaseUrl, serviceKey, tgId, data) {
  var url = supabaseUrl + '/rest/v1/habits?on_conflict=tg_id';
  var r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify([{ tg_id: tgId, data: data, updated_at: new Date().toISOString() }])
  });
  if (!r.ok) {
    var errText = await r.text().catch(function () { return '(тело ответа не читается)'; });
    throw new Error('Supabase write failed: HTTP ' + r.status + ' — ' + errText);
  }
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

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  var TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
    console.error('habits api: сервер не настроен — отсутствует одна из переменных окружения', {
      hasSupabaseUrl: !!SUPABASE_URL,
      hasServiceKey: !!SUPABASE_SERVICE_KEY,
      hasBotToken: !!TELEGRAM_BOT_TOKEN
    });
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
    console.error('habits api: подпись initData не сошлась', {
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

  try {
    if (body.action === 'read') {
      var data = await readHabits(SUPABASE_URL, SUPABASE_SERVICE_KEY, tgId);

      if (data === null) {
        res.status(200).json({
          ok: true,
          code: 'no_row',
          message: 'Для тебя в базе пока нет сохранённых данных.',
          data: null
        });
        return;
      }

      res.status(200).json({ ok: true, code: 'read_ok', data: data });
      return;
    }

    if (body.action === 'write') {
      if (body.data === undefined) {
        res.status(400).json({
          ok: false,
          code: 'missing_data',
          message: 'Нечего сохранять — данные не переданы.'
        });
        return;
      }
      await writeHabits(SUPABASE_URL, SUPABASE_SERVICE_KEY, tgId, body.data);
      res.status(200).json({ ok: true, code: 'write_ok' });
      return;
    }

    res.status(400).json({
      ok: false,
      code: 'unknown_action',
      message: 'Сервер не понял, что нужно сделать.'
    });
  } catch (e) {
    console.error('habits api: база не ответила (action=' + body.action + ', tg_id=' + tgId + ')', e);
    res.status(502).json({
      ok: false,
      code: 'database_unreachable',
      message: 'Не получилось сохранить/загрузить — сервер базы не ответил. Попробуем ещё раз.'
    });
  }
};
