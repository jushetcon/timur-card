// Общая проверка подписи initData для всех серверных функций.
// Алгоритм из документации Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
var crypto = require('crypto');

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

module.exports = { verifyTelegramInitData: verifyTelegramInitData };
