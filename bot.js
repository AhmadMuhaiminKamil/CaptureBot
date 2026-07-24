// bot.js — Core Telegram bot
import "dotenv/config";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { parseCaptureText } from "./parser.js";
import { extractTextFromImage, validateWorklog, processPhotoOCR } from "./ocr.js";
import { findSto } from "./stoMap.js";
import sharp from "sharp";

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY } = process.env;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN belum di-set");
  throw new Error("Missing BOT_TOKEN");
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️  SUPABASE_URL / SUPABASE_KEY belum di-set — mode read-only (WorkLog OCR saja)");
}

const bot = new Telegraf(BOT_TOKEN);

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

const PHOTO_BUCKET = "CaptureBinding_Images";

const TABLE_FOR_FORMAT = {
  binding: "binding_tickets",
  gno:     "gno_tickets",
  routing: "routing_tickets",
  ognok:   "ognok_tickets",
};

const LABEL_FOR_FORMAT = {
  binding: "Binding",
  gno:     "GNO/REGFAIL/PELLPAS",
  routing: "Routing",
  ognok:   "OG NOK",
};

// Template format untuk pesan error validasi (sama persis seperti capture_bot)
const FORMAT_TEMPLATE = {
  binding: [
    "Capture (Jika SC, Tampilkan TGL Create SC): (capture / required)",
    "No Tiket: (optional)",
    "No Service: (required)",
    "CLID lama, CLID baru, Domain: (required)",
    "CLID Lama: Wajib",
    "CLID Baru: Wajib",
    "Domain: Wajib",
    "Alasan Binding: (required)",
  ].join("\n"),
  gno: [
    "Capture: (capture / optional)",
    "No Tiket: (optional)",
    "No Service: (required)",
    "Keterangan, Password: (required)",
  ].join("\n"),
  routing: [
    "Capture: (capture / optional)",
    "No Tiket: (optional)",
    "No Service: (required)",
    "Ket. GPON/MSAN: (required)",
  ].join("\n"),
  ognok: [
    "Capture: (capture / optional)",
    "No Tiket: (optional)",
    "No Service: (required)",
    "Keterangan: (required)",
  ].join("\n"),
};

const COLUMNS_FOR_FORMAT = {
  binding: new Set([
    "telegram_user_id", "telegram_username", "telegram_chat_id",
    "raw_text", "photo_urls", "jenis", "nomor_tiket", "no_service",
    "clid_lama", "clid_baru", "domain", "alasan_binding", "sto_lama", "sto_baru", "worklog",
  ]),
  gno: new Set([
    "telegram_user_id", "telegram_username", "telegram_chat_id",
    "raw_text", "photo_urls", "jenis", "nomor_tiket", "no_service", "keterangan", "sto",
  ]),
  routing: new Set([
    "telegram_user_id", "telegram_username", "telegram_chat_id",
    "raw_text", "photo_urls", "jenis", "nomor_tiket", "no_service", "ket_gpon_msan", "sto",
  ]),
  ognok: new Set([
    "telegram_user_id", "telegram_username", "telegram_chat_id",
    "raw_text", "photo_urls", "jenis", "nomor_tiket", "no_service", "keterangan", "sto",
  ]),
};

// ── BUFFER & PENDING ─────────────────────────
const memBatchBuffer = new Map();
const MEM_BATCH_MAX_WAIT_MS = 6000;
const MEM_BATCH_QUIET_ROUNDS = 2;
const MEM_BATCH_POLL_MS = 600;

const formatPendingPhotos = new Map();

// ── HELPERS ───────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replyTo(ctx, replyToMessageId, text, extra = {}) {
  const replyExtra = replyToMessageId
    ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
    : {};
  return ctx.reply(text, { ...replyExtra, ...extra });
}

async function replyFormatFeedback(ctx, anchorId, parsed, worklogAda) {
  if (!parsed) return null; // Format tidak dikenal — silent, no feedback
  const formatLabel = LABEL_FOR_FORMAT[parsed.formatType] || parsed.formatType;
  const sender = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || '';
  if (!parsed.isValid) {
    return await replyTo(ctx, anchorId,
      `❌ Format ${formatLabel} tidak valid. ${sender}\n\n` +
      `Format yang benar untuk ${formatLabel}:\n\n` +
      FORMAT_TEMPLATE[parsed.formatType]
    );
  }
  if (parsed.formatType !== 'binding') {
    return await replyTo(ctx, anchorId, `✅ Format ${formatLabel} valid. ${sender}`);
  }
  const warn = checkBindingSpecial(parsed.data?.alasan_binding);
  if (warn) return await replyTo(ctx, anchorId, `${warn.replace('❌ ', `❌ ${sender} `)} `);
  const evidenceLabel = parsed.data?.jenis === 'Lapsung' ? 'evidence' : 'worklog';
  const worklogStr = worklogAda ? `(✅ ${evidenceLabel} ada)` : `(❌ ${evidenceLabel} tidak ada)`;
  return await replyTo(ctx, anchorId, `✅ Format ${formatLabel} valid. ${worklogStr} ${sender}`);
}

function filterColumnsForFormat(data, formatType) {
  const allowed = COLUMNS_FOR_FORMAT[formatType];
  if (!allowed) return data;
  return Object.fromEntries(Object.entries(data).filter(([k]) => allowed.has(k)));
}

function registerPendingFormat(ctx, anchorMsgId, pendingData) {
  const key = `${ctx.chat.id}_${ctx.from.id}_${anchorMsgId}`;
  formatPendingPhotos.set(key, { ...pendingData, createdAt: Date.now() });
  setTimeout(() => formatPendingPhotos.delete(key), 2 * 60 * 1000);
}

// ── WORKLOG OCR ───────────────────────────────

async function doOCR(ctx, photoArray) {
  try {
    const ocrResult = await processPhotoOCR(ctx, photoArray);
    const valid = ocrResult.validation.valid;
    console.log(`[OCR] valid=${valid} found=${JSON.stringify(ocrResult.validation.found)} textLen=${ocrResult.rawText?.length||0}`);
    if (!valid) console.log(`[OCR] rawText sample: ${ocrResult.rawText?.slice(0,300).replace(/\n/g,' ')}`);
    return valid;
  } catch (err) {
    console.error("[OCR] Error:", err);
    return null;
  }
}

function hasAnyValid(results) {
  return results.some(r => r === true);
}

// ── COMMANDS ──────────────────────────────────

bot.start((ctx) =>
  ctx.reply(
    "👋 Halo! Saya bot Capture + WorkLog OCR.\n\n" +
    "Forward pesan berisi foto screenshot WorkLog — saya akan OCR & validasi.\n" +
    "Atau forward pesan berisi foto + teks format capture (Binding, GNO, Routing, OG NOK).\n\n" +
    "Kirim /bantuan untuk info lebih lanjut."
  )
);

bot.command("cek", (ctx) => {
  ctx.reply("📸 Silakan kirim / forward foto screenshot WorkLog.");
});

bot.command(["bantuan", "help"], (ctx) => {
  ctx.reply(
    "📖 *Cara Penggunaan:*\n\n" +
    "*1. Cek WorkLog (OCR)*\n" +
    "Forward / kirim foto screenshot WorkLog → otomatis di-OCR & divalidasi.\n\n" +
    "*2. Format Capture*\n" +
    "Forward / kirim teks dengan format (boleh disertai foto):\n" +
    "• *Binding* — No Service, CLID Lama/Baru, Domain, Alasan Binding\n" +
    "• *GNO* — No Service, Keterangan & Password\n" +
    "• *Routing* — No Service, Ket. GPON/MSAN\n" +
    "• *OG NOK* — No Service, Keterangan\n\n" +
    "/cek — Mulai cek WorkLog\n" +
    "/bantuan — Bantuan ini",
    { parse_mode: "Markdown" }
  );
});

// ── BINDING SPECIAL VALIDATION ────────────────
// ponytail: keyword check only; ceiling: exact phrasing variants not covered
function checkBindingSpecial(a='') {
  if (/(?:ganti|pergantian|penggantian|replace|ubah)\s*ont\b/i.test(a)) {
    if (!(/\bSN\s*LAMA\b/i.test(a) && /\bSN\s*BARU\b/i.test(a)))
      return '❌ Mohon Sertakan:\nSN Lama:\nSN Baru:\nSilahkan Tambahkan di Alasan Binding';
  }
  if (/pindah\s*odp|pindah\s*port/i.test(a)) {
    // ponytail: also accept "dari ODP-xxx ke ODP-xxx" inline format
    const hasOdpPair = /\bODP\s*LAMA\b/i.test(a) ||
                       /\bdari\s+ODP[-\w/]+\s+ke\s+ODP[-\w/]+/i.test(a);
    if (!hasOdpPair)
      return '❌ Mohon Sertakan:\nODP Lama:\nODP Baru:\nSilahkan Tambahkan di Alasan Binding';
  }
  return null;
}

// ── FORMAT VALIDATION FEEDBACK (text-only) ────
async function handleFormatValidation(ctx, text, replyToMessageId) {
  const parsed = parseCaptureText(text);
  if (!parsed) return null; // Format gak dikenal — silent

  const formatLabel = LABEL_FOR_FORMAT[parsed.formatType] || parsed.formatType;
  const sender = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || '';

  let sentMsg;
  if (!parsed.isValid) {
    sentMsg = await replyTo(ctx, replyToMessageId,
      `❌ Format ${formatLabel} tidak valid. ${sender}\n\n` +
      `Format yang benar untuk ${formatLabel}:\n\n` +
      FORMAT_TEMPLATE[parsed.formatType]
    );
    console.log(`[FEEDBACK] ❌ Format ${formatLabel} tidak valid — ${ctx.from.username || ctx.from.first_name}`);
  } else {
    // Teks aja — gak ada foto, worklog tidak ada untuk binding
    if (parsed.formatType === 'binding') {
      const warn = checkBindingSpecial(parsed.data?.alasan_binding);
      if (warn) {
        sentMsg = await replyTo(ctx, replyToMessageId, `${warn.replace('❌ ', `❌ ${sender} `)} `);
        console.log(`[FEEDBACK] ❌ Binding special check gagal — ${ctx.from.username || ctx.from.first_name}`);
        return sentMsg?.message_id || null;
      }
    }
    const evLabel = parsed.data?.jenis === 'Lapsung' ? 'evidence' : 'worklog';
    const worklogPart = parsed.formatType === 'binding' ? ` (❌ ${evLabel} tidak ada)` : '';
    sentMsg = await replyTo(ctx, replyToMessageId,
      `✅ Format ${formatLabel} valid.${worklogPart} ${sender}`
    );
    console.log(`[FEEDBACK] ✅ Format ${formatLabel} valid — ${ctx.from.username || ctx.from.first_name}`);
  }
  return sentMsg?.message_id || null;
}

// ── UPLOAD ────────────────────────────────────

const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_RETRY_DELAY_MS = 2000;

async function uploadTelegramPhoto(ctx, photoArray) {
  const largest = photoArray[photoArray.length - 1];
  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const fileLink = await ctx.telegram.getFileLink(largest.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const originalBuffer = Buffer.from(arrayBuffer);
      const compressedBuffer = await sharp(originalBuffer)
        .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70, mozjpeg: true }).toBuffer();
      const fileName = `${Date.now()}_${largest.file_id}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from(PHOTO_BUCKET).upload(fileName, compressedBuffer, { contentType: "image/jpeg", upsert: false });
      if (uploadError) throw uploadError;
      return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(fileName).data.publicUrl;
    } catch (err) {
      lastError = err;
      console.error(`[UPLOAD] Attempt ${attempt} gagal:`, err.message);
      if (attempt < UPLOAD_MAX_RETRIES) await sleep(UPLOAD_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

// ── PROSES CAPTURE ────────────────────────────

async function processCaptureMessage(ctx, text, photoGroups, replyToMessageId, sourceMessageIds = [], worklogAda = null) {
  if (!supabase) return;
  const senderName = ctx.from.username ? `@${ctx.from.username}` : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  const parsed = parseCaptureText(text);
  if (!parsed) return;
  const { formatType } = parsed;
  const tableName = TABLE_FOR_FORMAT[formatType];
  if (!parsed.isValid) return;
  let photo_urls = [];
  if (Array.isArray(photoGroups) && photoGroups.length > 0) {
    for (const photoArray of photoGroups) {
      try {
        const url = await uploadTelegramPhoto(ctx, photoArray);
        photo_urls.push(url);
      } catch (err) {
        console.error(`Gagal upload foto (${senderName}):`, err.message);
        // ponytail: skip failed photo, still insert record with whatever uploaded
      }
    }
  }
  const rawRow = {
    telegram_user_id: ctx.from.id, telegram_username: ctx.from.username || null,
    telegram_chat_id: ctx.chat.id, raw_text: text,
    photo_urls: photo_urls.length ? photo_urls : null,
    ...parsed.data,
  };

  // Tambah STO dari no_service untuk format GNO/Routing/OG NOK
  if (formatType !== "binding" && rawRow.no_service) {
    const sto = findSto(rawRow.no_service);
    rawRow.sto = sto || null;
    console.log(`[STO] no_service=${rawRow.no_service} → sto=${sto || '(not found)'}`);
  }

  // Worklog status (binding only)
  if (formatType === "binding") {
    if (checkBindingSpecial(rawRow.alasan_binding)) return; // ponytail: skip insert if special check fails
    rawRow.worklog = worklogAda === true ? 'Ada' : 'Tidak Ada';
  }

  const row = filterColumnsForFormat(rawRow, formatType);

  // ponytail: delete duplicate nomor_tiket before insert — keeps newest, removes old
  // ceiling: race condition if two identical tickets sent simultaneously; accept for now
  if (rawRow.nomor_tiket) {
    await supabase.from(tableName).delete()
      .eq('telegram_chat_id', ctx.chat.id)
      .eq('nomor_tiket', rawRow.nomor_tiket);
  }

  const { data, error } = await supabase.from(tableName).insert(row).select().single();
  if (error) { console.error(`Supabase insert error (${senderName}):`, error); return; }
  console.log(`[DB] Insert ke ${tableName} ID=${data.id} (${senderName})`);
  await registerSubmissionMessages(ctx, data.id, formatType, [...sourceMessageIds]);
}

// ── BUFFER POLL ───────────────────────────────

async function bufferPollLoop(ctx, bufferKey) {
  const startedAt = Date.now();
  let lastCount = null;
  let quietRounds = 0;
  while (Date.now() - startedAt < MEM_BATCH_MAX_WAIT_MS) {
    await sleep(MEM_BATCH_POLL_MS);
    const batch = memBatchBuffer.get(bufferKey);
    if (!batch) return null;
    if (lastCount !== null && batch.length === lastCount) {
      quietRounds++;
    } else {
      quietRounds = 0;
      lastCount = batch.length;
    }
    if (quietRounds >= MEM_BATCH_QUIET_ROUNDS) break;
  }
  const batch = memBatchBuffer.get(bufferKey);
  memBatchBuffer.delete(bufferKey);
  return batch;
}

// ── HANDLE: FORWARDED ALBUM + CAPTION ──────
async function handleForwardedAlbum(ctx, mediaGroupId) {
  const bufferKey = `mg_${mediaGroupId}`;
  if (!memBatchBuffer.has(bufferKey)) memBatchBuffer.set(bufferKey, []);
  const batch = memBatchBuffer.get(bufferKey);
  batch.push(ctx.message);
  if (batch[0].message_id !== ctx.message.message_id) return;
  const claimed = await bufferPollLoop(ctx, bufferKey);
  if (!claimed || !claimed.length) return;
  const caption = claimed[0].caption;
  const photoGroups = claimed.map(m => m.photo);
  const anchorId = claimed[0].message_id;
  const ocrResults = [];
  for (const m of claimed) {
    const r = await doOCR(ctx, m.photo);
    ocrResults.push(r);
  }
  const worklogAda = hasAnyValid(ocrResults);
  if (caption) {
    const parsed = parseCaptureText(caption);
    const sent = await replyFormatFeedback(ctx, anchorId, parsed, worklogAda);
    const botReplyMsgId = sent?.message_id || null;
    console.log(`[FEEDBACK] ${parsed?.isValid ? '✅' : '❌'} Format ${parsed?.formatType || 'unknown'} (album) — ${ctx.from.username || ctx.from.first_name}`);
    if (parsed?.isValid && supabase) {
      const sourceIds = claimed.map(m => m.message_id);
      if (botReplyMsgId) sourceIds.push(botReplyMsgId);
      await processCaptureMessage(ctx, caption, photoGroups, anchorId, sourceIds, worklogAda).catch(e => console.error("DB err:", e));
    }
    if (parsed) {
      registerPendingFormat(ctx, anchorId, {
        text: caption, formatType: parsed.formatType, validCount: ocrResults.filter(r => r === true).length,
        totalCount: ocrResults.length, sourceIds: claimed.map(m => m.message_id),
      });
    }
  }
}

// ── HANDLE: SOLO FOTO + CAPTION ────────────
async function handleSoloWithCaption(ctx) {
  const r = await doOCR(ctx, ctx.message.photo);
  const parsed = parseCaptureText(ctx.message.caption);
  const sent = await replyFormatFeedback(ctx, ctx.message.message_id, parsed, r === true);
  const botReplyMsgId = sent?.message_id || null;
  console.log(`[FEEDBACK] ${parsed?.isValid ? '✅' : '❌'} Format ${parsed?.formatType || 'unknown'} (foto+caption) — ${ctx.from.username || ctx.from.first_name}`);
  if (parsed?.isValid && supabase) {
    const sourceIds = [ctx.message.message_id];
    if (botReplyMsgId) sourceIds.push(botReplyMsgId);
    await processCaptureMessage(ctx, ctx.message.caption, [ctx.message.photo], ctx.message.message_id, sourceIds, r === true).catch(e => console.error("DB err:", e));
  }
  if (parsed) {
    registerPendingFormat(ctx, ctx.message.message_id, {
      text: ctx.message.caption, formatType: parsed.formatType, validCount: r === true ? 1 : 0, totalCount: 1,
      sourceIds: [ctx.message.message_id],
    });
  }
}

// ── HANDLE: SOLO FOTO (no caption) ─────────
async function handleSoloNoCaption(ctx) {
  await doOCR(ctx, ctx.message.photo); // bg only
}

// ── HANDLE: ALBUM FOTO (no caption) ─────────
async function handleAlbumNoCaption(ctx, mediaGroupId) {
  const bufferKey = `mg_${mediaGroupId}`;
  if (!memBatchBuffer.has(bufferKey)) memBatchBuffer.set(bufferKey, []);
  const batch = memBatchBuffer.get(bufferKey);
  batch.push(ctx.message);
  if (batch[0].message_id !== ctx.message.message_id) return;
  const claimed = await bufferPollLoop(ctx, bufferKey);
  if (!claimed || !claimed.length) return;
  for (const m of claimed) { await doOCR(ctx, m.photo); }
}

// ── HANDLE: TEKS SAJA ──────────────────────
async function handleTextOnly(ctx) {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  const parsed = parseCaptureText(text);
  if (!parsed) return; // Format tidak dikenal — silent
  registerPendingFormat(ctx, ctx.message.message_id, {
    text, formatType: parsed.formatType, validCount: 0, totalCount: 0, sourceIds: [ctx.message.message_id],
  });
  const botReplyMsgId = await handleFormatValidation(ctx, text, ctx.message.message_id);
  if (botReplyMsgId) {
    registerPendingFormat(ctx, botReplyMsgId, {
      text, formatType: parsed.formatType, validCount: 0, totalCount: 0,
      sourceIds: [ctx.message.message_id, botReplyMsgId],
    });
  }
  if (parsed.isValid && supabase) {
    const sourceIds = [ctx.message.message_id];
    if (botReplyMsgId) sourceIds.push(botReplyMsgId);
    await processCaptureMessage(ctx, text, [], ctx.message.message_id, sourceIds).catch(e => console.error("DB err:", e));
  }
}

// ponytail: set of msg_ids handled by edited_message this tick — prevents double-handling
const _editedThisTick = new Set();

// ── MAIN HANDLER ───────────────────────────
bot.on(["text", "photo"], async (ctx) => {
  const updateType = Object.keys(ctx.update).filter(k=>k!=='update_id')[0];
  console.log(`[MAIN] handler fired: updateType=${updateType} edit_date=${ctx.message?.edit_date}`);
  if (ctx.message?.edit_date) {
    console.log(`[MAIN] Skipping edited message ${ctx.message.message_id}`);
    return;
  }
  const isPhoto = Array.isArray(ctx.message.photo);
  if (!isPhoto) { await handleTextOnly(ctx); return; }
  const mediaGroupId = ctx.message.media_group_id;
  const hasCaption = !!ctx.message.caption;
  const repliedMsg = ctx.message.reply_to_message;

  // HANDLE: Reply foto → UPDATE existing record's photo_urls, NO FEEDBACK
  // ponytail: bypass in-memory formatPendingPhotos (unreliable on serverless) — query DB directly
  if (repliedMsg && !hasCaption && !mediaGroupId && supabase) {
    let tm = null;
    for (let i = 0; i < 10 && !tm; i++) {
      if (i > 0) await sleep(2000);
      const { data } = await supabase
        .from("capture_ticket_messages")
        .select("ticket_id, format_type")
        .eq("chat_id", ctx.chat.id)
        .eq("message_id", repliedMsg.message_id)
        .maybeSingle();
      tm = data;
    }
    if (tm) {
      const tableName = TABLE_FOR_FORMAT[tm.format_type];
      const sender = ctx.from.username || ctx.from.first_name;
      console.log(`[REPLY PHOTO] Foto reply ke format ${tm.format_type} — ${sender}`);
      try {
        const [ocrValid, url] = await Promise.all([
          tm.format_type === 'binding' ? doOCR(ctx, ctx.message.photo) : Promise.resolve(null),
          uploadTelegramPhoto(ctx, ctx.message.photo),
        ]);
        const { data: existingRow } = await supabase
          .from(tableName).select("photo_urls").eq("id", tm.ticket_id).maybeSingle();
        if (existingRow) {
          const newUrls = [...(Array.isArray(existingRow.photo_urls) ? existingRow.photo_urls : []), url];
          await supabase.from(tableName).update({ photo_urls: newUrls }).eq("id", tm.ticket_id);
          console.log(`[REPLY PHOTO] ✅ Ditambahkan foto ke ${tableName} ID=${tm.ticket_id} (total ${newUrls.length})`);
        }
        // Edit bot feedback + update DB worklog jika binding + worklog terdeteksi
        if (tm.format_type === 'binding' && ocrValid === true) {
          await supabase.from('binding_tickets').update({ worklog: 'Ada' }).eq('id', tm.ticket_id);
          const { data: msgs } = await supabase
            .from("capture_ticket_messages")
            .select("message_id")
            .eq("chat_id", ctx.chat.id)
            .eq("ticket_id", tm.ticket_id)
            .order("message_id", { ascending: false })
            .limit(1);
          const botMsgId = msgs?.[0]?.message_id;
          if (botMsgId) {
            const senderTag = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
            await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null,
              `✅ Format Binding valid. (✅ ${/lapsung/i.test(tm.ticket_id) ? 'evidence' : 'worklog'} ada) ${senderTag}`
            ).catch(() => {}); // silent if edit fails (too old, etc)
            console.log(`[REPLY PHOTO] ✏️ Edited bot msg ${botMsgId} → worklog ada`);
          }
        }
      } catch (err) {
        console.error(`[REPLY PHOTO] Gagal upload/update foto:`, err);
      }
      return;
    }
  }

  if (mediaGroupId) { await handleForwardedAlbum(ctx, mediaGroupId); return; }
  if (hasCaption) { await handleSoloWithCaption(ctx); return; }
  await handleSoloNoCaption(ctx);
});

// ── HANDLE: EDITED TEXT MESSAGE ───────────────
// ponytail: only text edits; photo edits ignored (rare, complex)
bot.on("edited_message", async (ctx) => {
  const text = ctx.editedMessage?.text;
  if (!text) return;
  const msgId = ctx.editedMessage.message_id;
  _editedThisTick.add(msgId);
  setTimeout(() => _editedThisTick.delete(msgId), 5000); // ponytail: 5s window, serverless safe
  const parsed = parseCaptureText(text);
  if (!parsed) return; // unknown format → silent
  const sender = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || '';
  const formatLabel = LABEL_FOR_FORMAT[parsed.formatType] || parsed.formatType;
  if (!parsed.isValid) {
    await ctx.reply(
      `❌ Format ${formatLabel} tidak valid. ${sender}\n\nFormat yang benar untuk ${formatLabel}:\n\n${FORMAT_TEMPLATE[parsed.formatType]}`,
      { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }
    ).catch(() => {});
    return;
  }
  // Check binding special rules (ONT/ODP) on edited message too
  if (parsed.formatType === 'binding') {
    const warn = checkBindingSpecial(parsed.data?.alasan_binding);
    if (warn) {
      await ctx.reply(`${warn.replace('❌ ', `❌ ${sender} `)} `,
        { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }
      ).catch(() => {});
      return;
    }
  }
  const evLabel2 = parsed.data?.jenis === 'Lapsung' ? 'evidence' : 'worklog';
  const worklogPart = parsed.formatType === 'binding' ? ` (❌ ${evLabel2} tidak ada)` : '';
  const feedback = `✅ Format ${formatLabel} valid.${worklogPart} ${sender}`;
  // Try to edit existing bot reply for this message
  if (supabase) {
    const { data: tm } = await supabase
      .from("capture_ticket_messages")
      .select("ticket_id, format_type, message_id")
      .eq("chat_id", ctx.chat.id)
      .eq("message_id", msgId)
      .maybeSingle();
    if (tm) {
      // Re-check special binding rules on edit
      if (parsed.formatType === 'binding') {
        const warn = checkBindingSpecial(parsed.data?.alasan_binding);
        // Find the bot reply for this ticket to edit it
        const { data: botMsgs } = await supabase
          .from('capture_ticket_messages')
          .select('message_id')
          .eq('chat_id', ctx.chat.id)
          .eq('ticket_id', tm.ticket_id)
          .order('message_id', { ascending: false })
          .limit(1);
        const botMsgId = botMsgs?.[0]?.message_id;
        console.log(`[EDIT-DEBUG] tm.ticket_id=${tm.ticket_id} botMsgId=${botMsgId} warn=${!!checkBindingSpecial(parsed.data?.alasan_binding)}`);
        if (warn) {
          const warnText = `${warn.replace('❌ ', `❌ ${sender} `)} `;
          if (botMsgId) await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, warnText).catch(() => {});
          else await ctx.telegram.sendMessage(ctx.chat.id, warnText, { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }).catch(() => {});
          return;
        }
        // Special check passed — update DB + edit bot reply to valid
        if (parsed.data?.alasan_binding) {
          await supabase.from('binding_tickets').update({ alasan_binding: parsed.data.alasan_binding }).eq('id', tm.ticket_id);
          console.log(`[EDIT] Updated alasan_binding ticket ${tm.ticket_id}`);
        }
        if (botMsgId) await ctx.telegram.editMessageText(ctx.chat.id, botMsgId, null, feedback).catch(() => {});
        else await ctx.telegram.sendMessage(ctx.chat.id, feedback, { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }).catch(() => {});
        return;
      }
      return;
    }
    // Find bot reply linked to this user message via source lookup
    const { data: rows } = await supabase
      .from("capture_ticket_messages")
      .select("message_id, ticket_id")
      .eq("chat_id", ctx.chat.id)
      .order("message_id", { ascending: false })
      .limit(20);
    // Bot reply = highest message_id row not from user (no direct way to tell, use editedMessage as anchor)
    // Lazy: find nearest bot msg_id > msgId that's registered
    const botRow = rows?.find(r => r.message_id > msgId);
    if (botRow) {
      await ctx.telegram.editMessageText(ctx.chat.id, botRow.message_id, null, feedback).catch(() => {});
    }
    // ponytail: sendMessage direct, ctx.reply may silently fail on edited_message context
    await ctx.telegram.sendMessage(ctx.chat.id, feedback,
      { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }
    ).catch(e => console.error('[EDIT] sendMessage failed:', e.message));
    // Insert to DB
    await processCaptureMessage(ctx, text, [], msgId, [msgId]).catch(e => console.error("DB err (edit):", e));
  } else {
    await ctx.telegram.sendMessage(ctx.chat.id, feedback,
      { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }
    ).catch(e => console.error('[EDIT] sendMessage failed:', e.message));
  }
  console.log(`[EDIT] Format ${formatLabel} valid setelah edit — ${ctx.from.username || ctx.from.first_name}`);
});

// ── SUPABASE HELPERS ──────────────────────
const STALE_BUFFER_MS = 2 * 60 * 1000;
async function cleanupStaleBuffers() {
  if (!supabase) return;
  const staleBefore = new Date(Date.now() - STALE_BUFFER_MS).toISOString();
  await supabase.from("photo_batch_buffer").delete().lt("created_at", staleBefore);
  await supabase.from("pending_photo_buffer").delete().lt("updated_at", staleBefore);
}
async function registerSubmissionMessages(ctx, ticketId, formatType, messageIds) {
  if (!supabase || !messageIds.length) return;
  const rows = messageIds.filter(id => id != null).map(message_id => ({
    chat_id: ctx.chat.id, message_id, ticket_id: ticketId, format_type: formatType,
  }));
  await supabase.from("capture_ticket_messages").upsert(rows, { onConflict: "chat_id,message_id" });
}

export default bot;
