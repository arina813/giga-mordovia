const crypto = require('crypto');

// GigaChat access tokens live for 30 minutes. Reuse a token while the
// current Vercel function instance remains warm; obtain a new one as needed.
let cachedAccessToken = null;
let cachedTokenExpiresAt = 0;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Используйте POST-запрос.' });
  }

  const authKey = process.env.GIGACHAT_AUTH_KEY;
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  const model = process.env.GIGACHAT_MODEL || 'GigaChat';

  if (!authKey || !authKey.trim()) {
    console.error('LISICHKA_DIAG: GIGACHAT_AUTH_KEY is missing');
    return res.status(500).json({
      error: 'Сервер не получил GIGACHAT_AUTH_KEY. Добавьте Authorization Key в переменные Vercel.'
    });
  }

  const systemInstruction = `Ты — Лисичка, дружелюбный туристический помощник сайта «Шумбрат — Мордовия». Помогай планировать поездки по Саранску и Республике Мордовия.

Главное правило: всегда старайся дать полный, законченный ответ за одно сообщение. Не дели ответ на части и никогда не предлагай пользователю написать «продолжай», чтобы получить оставшуюся информацию. Не обрывай маршрут на середине.

Если пользователь просит составить маршрут на день, сразу распиши весь день: утро, обед, вторая половина дня и вечер. Для каждой остановки кратко объясни, что там посмотреть и зачем туда идти. В конце дай несколько практических советов.

Если пользователь просит подробный план, включай все основные пункты сразу. Если информации много, сокращай второстепенные подробности, но сохраняй целостность ответа.

Пиши естественным русским языком, тепло и без шаблонных вступлений. Не используй Markdown-разметку: символы #, звёздочки для выделения и списков, обратные кавычки и таблицы. Используй обычные названия разделов и короткие абзацы.

Учитывай предыдущие сообщения и не заставляй пользователя повторять уже сообщённые пожелания. Если данных достаточно, не задавай лишних вопросов — предложи разумный вариант и при необходимости укажи свои предположения.

Не выдумывай точные цены, расписания, часы работы, наличие мест и текущую погоду. Если эти сведения неизвестны, предупреди, что их нужно проверить перед поездкой.`;

  async function readJson(response) {
    return response.json().catch(() => ({}));
  }

  async function getAccessToken() {
    const now = Date.now();
    if (cachedAccessToken && cachedTokenExpiresAt > now + 60_000) {
      return cachedAccessToken;
    }

    const tokenResponse = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authKey.trim()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'RqUID': crypto.randomUUID()
      },
      body: new URLSearchParams({ scope }),
      signal: AbortSignal.timeout(15000)
    });

    const tokenData = await readJson(tokenResponse);
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('LISICHKA_DIAG: GigaChat OAuth HTTP', tokenResponse.status,
        tokenData.message || tokenData.error_description || tokenData.error || 'Не удалось получить access token');
      const error = new Error('Не удалось авторизоваться в GigaChat. Проверьте Authorization Key и scope.');
      error.status = tokenResponse.status;
      throw error;
    }

    cachedAccessToken = tokenData.access_token;
    // expires_at is a Unix timestamp in milliseconds in the current API.
    // Fall back to a conservative 29-minute lifetime if it is absent/invalid.
    const expiresAt = Number(tokenData.expires_at);
    cachedTokenExpiresAt = Number.isFinite(expiresAt) && expiresAt > now
      ? expiresAt
      : now + 29 * 60 * 1000;
    return cachedAccessToken;
  }

  try {
    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const history = incoming
      .filter(m => (m.role === 'user' || m.role === 'model' || m.role === 'assistant') && Array.isArray(m.parts))
      .slice(-12)
      .map(m => ({
        role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
        content: m.parts
          .filter(p => p && typeof p.text === 'string')
          .map(p => p.text.slice(0, 4000))
          .join('\n')
      }))
      .filter(m => m.content.trim());

    if (!history.length || !history.some(m => m.role === 'user')) {
      return res.status(400).json({ error: 'Напишите сообщение Лисичке.' });
    }

    const accessToken = await getAccessToken();
    const chatResponse = await fetch('https://api.giga.chat/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          ...history
        ],
        temperature: 0.7,
        max_tokens: 1800,
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });

    const result = await readJson(chatResponse);
    if (!chatResponse.ok) {
      const detail = result.message || result.error?.message || result.error || 'GigaChat не предоставил описание ошибки';
      console.error('LISICHKA_DIAG: GigaChat HTTP', chatResponse.status, detail);
      return res.status(502).json({
        error: `GigaChat не смог ответить (HTTP ${chatResponse.status}). Проверьте журнал Vercel.`
      });
    }

    const reply = result.choices?.[0]?.message?.content;
    const replyText = typeof reply === 'string' ? reply.trim() : '';
    if (!replyText) {
      console.error('LISICHKA_DIAG: GigaChat returned empty response', JSON.stringify(result).slice(0, 1200));
      return res.status(502).json({ error: 'GigaChat вернул пустой ответ. Попробуйте задать вопрос ещё раз.' });
    }

    console.log('LISICHKA_DIAG: GigaChat success; model:', model);
    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error('LISICHKA_DIAG: GigaChat internal error', error.message || String(error));
    return res.status(error.status === 401 || error.status === 403 ? 502 : 500).json({
      error: error.message || 'Лисичка временно недоступна. Попробуйте ещё раз.'
    });
  }
};
