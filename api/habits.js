// Серверная функция-посредник между страницей и базой Supabase.
// Выполняется на сервере Vercel — секреты берутся только из переменных
// окружения и никогда не уходят в код страницы.
var crypto = require('crypto');

// Проверка подписи initData по алгоритму Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') return null;

  var params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return null;
  }

  var hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  var pairs = [];
  params.forEach(function (value, key) {
    pairs.push(key + '=' + value);
  });
  pairs.sort();
  var dataCheckString = pairs.join('\n');

  var secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  var computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  var a = Buffer.from(computedHash, 'utf8');
  var b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // отклоняем слишком старые initData (больше суток) — на случай повторного использования
  var authDate = Number(params.get('auth_date'));
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) return null;

  var userJson = params.get('user');
  if (!userJson) return null;

  var user;
  try {
    user = JSON.parse(userJson);
  } catch (e) {
    return null;
  }
  if (!user || typeof user.id !== 'number') return null;

  return { id: user.id };
}

async function readHabits(supabaseUrl, serviceKey, tgId) {
  var url = supabaseUrl + '/rest/v1/habits?tg_id=eq.' + tgId + '&select=data&limit=1';
  var r = await fetch(url, {
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey
    }
  });
  if (!r.ok) throw new Error('supabase_read_failed');
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
  if (!r.ok) throw new Error('supabase_write_failed');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  var SUPABASE_URL = process.env.SUPABASE_URL;
  var SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  var TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ ok: false, error: 'server_not_configured' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  body = body || {};

  var verifiedUser = verifyTelegramInitData(body.initData, TELEGRAM_BOT_TOKEN);
  if (!verifiedUser) {
    res.status(401).json({ ok: false, error: 'invalid_init_data' });
    return;
  }

  var tgId = verifiedUser.id;

  try {
    if (body.action === 'read') {
      var data = await readHabits(SUPABASE_URL, SUPABASE_SERVICE_KEY, tgId);
      res.status(200).json({ ok: true, data: data });
      return;
    }

    if (body.action === 'write') {
      if (body.data === undefined) {
        res.status(400).json({ ok: false, error: 'missing_data' });
        return;
      }
      await writeHabits(SUPABASE_URL, SUPABASE_SERVICE_KEY, tgId, body.data);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'supabase_unreachable' });
  }
};
