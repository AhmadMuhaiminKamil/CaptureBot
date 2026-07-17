// api/webhook.js — Vercel serverless function entry point
// Handler untuk Telegram webhook di Vercel

import bot from "../bot.js";
import { waitUntil } from "@vercel/functions";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("Webhook aktif, kirim POST dari Telegram di sini.");
    return;
  }

  // WAJIB dibales SECEPATNYA — jangan nunggu proses berat selesai.
  // Kalau kelamaan, Telegram bakal nahan/re-queue update berikutnya.
  res.status(200).send("OK");

  // Proses beneran jalan di BACKGROUND via waitUntil()
  waitUntil(
    bot.handleUpdate(req.body).catch((err) => {
      console.error("Gagal proses update Telegram:", err);
    })
  );
}