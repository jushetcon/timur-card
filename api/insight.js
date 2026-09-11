// Короткий ИИ-разбор недели по отметкам привычек.
// Ключ Anthropic — только из переменной окружения, на страницу не попадает.
var verifyTelegramInitData = require('./_lib/telegram').verifyTelegramInitData;
var Anthropic = require('@anthropic-ai/sdk');

// claude-haiku-4-5 — разбор короткий, платить за более тяжёлую модель незачем
var MODEL = 'claude-haiku-4-5-20251001';

async function readHabitsData(supabaseUrl, serviceKey, tgId) {
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

// последние 7 календарных дней по UTC — точная граница суток пользователя нам
// не известна (initData её не передаёт), для недельной сводки это достаточно точно
function last7Days() {
  var days = [];
  var now = new Date();
  for (var i = 0; i < 7; i++) {
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var day = String(d.getUTCDate()).padStart(2, '0');
    days.push(y + '-' + m + '-' + day);
  }
  return days;
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
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !ANTHROPIC_API_KEY) {
    console.error('insight api: сервер не настроен — отсутствует одна из переменных окружения', {
      hasSupabaseUrl: !!SUPABASE_URL,
      hasServiceKey: !!SUPABASE_SERVICE_KEY,
      hasBotToken: !!TELEGRAM_BOT_TOKEN,
      hasAnthropicKey: !!ANTHROPIC_API_KEY
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
    console.error('insight api: подпись initData не сошлась', {
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

  var habitsData;
  try {
    habitsData = await readHabitsData(SUPABASE_URL, SUPABASE_SERVICE_KEY, tgId);
  } catch (e) {
    console.error('insight api: не удалось прочитать привычки (tg_id=' + tgId + ')', e);
    res.status(502).json({
      ok: false,
      code: 'database_unreachable',
      message: 'Не получилось загрузить данные для разбора. Попробуй ещё раз.'
    });
    return;
  }

  var habits = (habitsData && Array.isArray(habitsData.habits)) ? habitsData.habits : [];

  if (habits.length === 0) {
    res.status(200).json({
      ok: true,
      code: 'no_habits',
      text: 'Пока нет ни одной привычки — разбирать нечего. Заведи хотя бы одну на экране «Привычки».'
    });
    return;
  }

  var last7 = last7Days();
  var summary = habits.map(function (h) {
    var dates = Array.isArray(h.dates) ? h.dates : [];
    var doneCount = last7.filter(function (d) { return dates.indexOf(d) !== -1; }).length;
    return { name: h.name, doneCount: doneCount };
  });

  var hasAnyActivity = summary.some(function (s) { return s.doneCount > 0; });
  if (!hasAnyActivity) {
    res.status(200).json({
      ok: true,
      code: 'no_activity',
      text: 'За последние 7 дней ни одна привычка не отмечена — начни с малого, отметь хотя бы одну сегодня.'
    });
    return;
  }

  var promptLines = summary.map(function (s) {
    return '- ' + s.name + ': ' + s.doneCount + ' из 7 дней';
  }).join('\n');

  try {
    var anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    var message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content:
          'Вот статистика выполнения привычек человека за последние 7 дней:\n\n' +
          promptLines +
          '\n\nНапиши короткий (3-5 предложений) дружелюбный разбор недели на русском ' +
          'языке: что получается хорошо, на что обратить внимание. Без нравоучений и ' +
          'категоричных советов, обращайся на "ты".'
      }]
    });

    var textBlock = message.content && message.content.filter(function (b) { return b.type === 'text'; })[0];
    var text = textBlock ? textBlock.text.trim() : 'Не получилось разобрать неделю — попробуй ещё раз.';

    res.status(200).json({ ok: true, code: 'insight_ok', text: text });
  } catch (e) {
    console.error('insight api: сбой обращения к Anthropic (tg_id=' + tgId + ')', e);
    res.status(502).json({
      ok: false,
      code: 'ai_unreachable',
      message: 'Не получилось получить разбор от ИИ. Попробуй ещё раз.'
    });
  }
};
