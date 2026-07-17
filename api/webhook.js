// api/webhook.js — Vercel serverless function for Telegram webhook
import bot from "../bot.js";
import { waitUntil } from "@vercel/functions";

// In-memory recent log buffer (per-instance, ~last 50 entries)
const recentLog = [];
const MAX = 60;
function cap(a) { while (a.length > MAX) a.shift(); }
function pushLog(level, ...args) {
  const msg = args.map(a => (typeof a === 'object' ? (a.stack || JSON.stringify(a, null, 2)) : String(a))).join(' ');
  recentLog.push({ t: new Date().toISOString(), level, msg });
  cap(recentLog);
}
// Intercept console
const _error = console.error; console.error = (...a) => { pushLog('ERROR', ...a); _error.apply(console, a); };
const _warn  = console.warn;  console.warn  = (...a) => { pushLog('WARN', ...a);  _warn.apply(console, a); };
const _log   = console.log;   console.log   = (...a) => { pushLog('LOG', ...a);   _log.apply(console, a); };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    const url = new URL(req.url, 'http://x');
    // /debug → log dump
    if (url.pathname.startsWith('/debug')) {
      return res.status(200).json({ ok: true, entries: recentLog });
    }
    // / → health
    return res.status(200).json({ ok: true, message: "Capture WorkLog Bot running 🤖" });
  }
  if (req.method !== "POST") return res.status(200).send("webhook active");
  // Respond immediately, process in background
  res.status(200).send("OK");
  waitUntil(
    bot.handleUpdate(req.body).catch(e => console.error("handleUpdate error:", e))
  );
}
