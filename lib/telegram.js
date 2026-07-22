// lib/telegram.js
const TELEGRAM_API = 'https://api.telegram.org';

export async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

export async function setTelegramWebhook(botToken, url) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Telegram setWebhook failed: ${res.status}`);
  return res.json();
}
