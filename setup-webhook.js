/**
 * Setup Telegram webhook ke Vercel.
 * Jalankan: BOT_TOKEN=xxx VERCEL_URL=https://xxx.vercel.app node setup-webhook.js
 * Atau: node setup-webhook.js (baca dari .env)
 */
import "dotenv/config";

const BOT_TOKEN  = process.env.BOT_TOKEN;
const VERCEL_URL = process.env.VERCEL_URL;

if (!BOT_TOKEN || !VERCEL_URL) {
  console.error('❌ Set BOT_TOKEN dan VERCEL_URL dulu!');
  console.error('   BOT_TOKEN=xxx VERCEL_URL=https://xxx.vercel.app node setup-webhook.js');
  process.exit(1);
}

const webhookUrl = `${VERCEL_URL}/webhook`;

const res = await fetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }),
  }
);

const data = await res.json();
if (data.ok) {
  console.log(`✅ Webhook berhasil diset ke: ${webhookUrl}`);
} else {
  console.error('❌ Gagal set webhook:', data);
}
