// start.js — Entry point untuk mode POLLING (long-polling, cocok untuk Render/VPS/lokal)
// Bisa jalan tanpa Vercel. Gunakan: BOT_TOKEN=xxx node start.js

import "dotenv/config";
import bot from "./bot.js";

const PORT = process.env.PORT || 8080;

// Simple HTTP server untuk health check (Render butuh ini)
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Capture WorkLog Bot is running! 🤖" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Capture WorkLog Bot is running! 🤖");
});

server.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// Start bot polling
async function startBot() {
  console.log("🤖 Starting bot in polling mode...");

  // Hapus webhook kalau ada (supaya polling jalan)
  try {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    console.log("✅ Webhook deleted (if any)");
  } catch (e) {
    console.warn("⚠️  Could not delete webhook:", e.message);
  }

  // Launch
  bot.launch()
    .then(() => console.log("✅ Bot polling started!"))
    .catch((err) => console.error("❌ Bot launch error:", err));
}

startBot();

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));