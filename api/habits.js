// Серверная функция-посредник между страницей и базой Supabase.
// Выполняется на сервере Vercel — секретный ключ сюда попадает только
// через переменные окружения и никогда не уходит в код страницы.
module.exports = function handler(req, res) {
  var supabaseConfigured = Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  );

  res.status(200).json({
    ok: true,
    message: 'Сервер жив',
    supabaseConfigured: supabaseConfigured
  });
};
