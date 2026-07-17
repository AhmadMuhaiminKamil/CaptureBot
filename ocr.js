// ocr.js
// OCR module using tesseract.js + Sharp preprocessing
// Includes: zone-based OCR, fuzzy WorkLog validation, and photo processing

import { createWorker } from "tesseract.js";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import {
  REQUIRED_KEYWORDS,
  WORKLOG_ALTERNATIVE,
  MIN_KEYWORD_MATCH,
  FUZZY_THRESHOLD,
  PARTIAL_THRESHOLD,
  MIN_WORD_LENGTH,
} from "./worklogValidator.js";

// ── FUZZY MATCH UTILITIES ─────────────────────────

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function ratio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return (1 - levenshtein(a, b) / maxLen) * 100;
}

function partialRatio(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let best = 0;
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    const score = ratio(shorter, longer.slice(i, i + shorter.length));
    if (score > best) best = score;
  }
  return best;
}

function fuzzyMatch(kw, textLower, words) {
  if (textLower.includes(kw)) return true;
  if (words.some((w) => ratio(kw, w) >= FUZZY_THRESHOLD)) return true;
  const similarLen = words.filter((w) => Math.abs(w.length - kw.length) <= 2);
  if (similarLen.some((w) => partialRatio(kw, w) >= PARTIAL_THRESHOLD)) return true;
  return false;
}

// ── WORKLOG VALIDATOR ─────────────────────────────

export function validateWorklog(text) {
  const textLower = text.toLowerCase();
  const words = textLower.split(/\s+/).filter((w) => w.length >= MIN_WORD_LENGTH);
  const found = [];
  const missing = [];

  for (const kw of REQUIRED_KEYWORDS) {
    (fuzzyMatch(kw, textLower, words) ? found : missing).push(kw);
  }

  if (missing.includes("worklog")) {
    const altFound = WORKLOG_ALTERNATIVE.find((kw) => fuzzyMatch(kw, textLower, words));
    if (altFound) {
      found.push(`worklog~${altFound}`);
      missing.splice(missing.indexOf("worklog"), 1);
    }
  }

  const valid = found.length >= MIN_KEYWORD_MATCH;
  return { valid, found, missing, rawText: text };
}

// ── IMAGE PREPROCESSING (Sharp zones) ─────────────

async function preprocessImage(imageBytes) {
  const meta = await sharp(imageBytes).metadata();
  const w = meta.width;
  const h = meta.height;
  const scale = 4;

  const zones = [
    { left: 0, top: 0, width: w, height: Math.floor(h * 0.4) }, // atas
    { left: 0, top: 0, width: Math.floor(w * 0.5), height: h }, // kiri
    {
      left: 0,
      top: Math.floor(h * 0.1),
      width: Math.floor(w * 0.55),
      height: Math.floor(h * 0.5),
    }, // tengah_kiri
  ];

  const buffers = [];
  for (const zone of zones) {
    const buf = await sharp(imageBytes)
      .extract(zone)
      .resize(zone.width * scale, zone.height * scale)
      .sharpen()
      .sharpen()
      .grayscale()
      .png()
      .toBuffer();
    buffers.push(buf);
  }
  return buffers;
}

// ── CORE PATH RESOLUTION ──────────────────────────

function getCorePath() {
  const candidates = [
    path.join(process.cwd(), "api", "tesseract.js-core"),
    path.join(process.cwd(), "api", "_core"),
    path.join(process.cwd(), "node_modules", "tesseract.js-core"),
  ];
  for (const p of candidates) {
    const wasmFile = path.join(p, "tesseract-core-simd.wasm");
    if (fs.existsSync(wasmFile)) return p;
  }
  // fallback: let tesseract.js resolve itself
  return undefined;
}

// ── LANG PATH RESOLUTION ──────────────────────────

function getLangPath() {
  const candidates = [
    "/tmp/tessdata", // Vercel runtime
    path.join(process.cwd(), "api", "lang-data"), // local dev
    path.join(process.cwd(), "node_modules", "tesseract.js", "lang-data"),
  ];
  for (const p of candidates) {
    if (
      fs.existsSync(path.join(p, "eng.traineddata.gz")) ||
      fs.existsSync(path.join(p, "eng.traineddata"))
    ) {
      return p;
    }
  }
  return undefined; // let tesseract.js auto-download
}

// ── MAIN OCR FUNCTION ─────────────────────────────

export async function extractTextFromImage(imageBytes) {
  const langPath = getLangPath();
  console.log("[OCR] langPath:", langPath);

  // Try zone-based OCR first
  try {
    const zoneBuffers = await preprocessImage(imageBytes);
    const corePath = getCorePath();
    const worker = await createWorker("eng", 1, {
      logger: () => {},
      langPath,
      corePath,
    });

    let allText = "";
    try {
      for (const buf of zoneBuffers) {
        const { data: { text } } = await worker.recognize(buf);
        allText += " " + text;
      }
    } finally {
      await worker.terminate();
    }
    console.log("[OCR] Zone OCR result length:", allText.length);
    return allText.trim();
  } catch (err) {
    console.warn("[OCR] Zone OCR failed, fallback direct:", err.message);
  }

  // Fallback: direct OCR on full image
  try {
    const corePath = getCorePath();
    const worker = await createWorker("eng", 1, {
      logger: () => {},
      langPath,
      corePath,
    });
    try {
      const { data: { text } } = await worker.recognize(imageBytes);
      console.log("[OCR] Fallback direct OCR result length:", text.length);
      return text.trim();
    } finally {
      await worker.terminate();
    }
  } catch (err) {
    console.error("[OCR] All OCR attempts failed:", err);
    throw err;
  }
}

// ── HIGH-LEVEL: Process photo from Telegram ───────

export async function processPhotoOCR(ctx, photoArray) {
  const largest = photoArray[photoArray.length - 1];

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fileLink = await ctx.telegram.getFileLink(largest.file_id);

      const response = await fetch(fileLink.href);
      if (!response.ok) {
        throw new Error(`Failed to download photo from Telegram (status ${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const imageBytes = Buffer.from(arrayBuffer);

      // Extract text via OCR
      const rawText = await extractTextFromImage(imageBytes);

      // Validate WorkLog
      const validation = validateWorklog(rawText);

      return {
        rawText,
        validation,
        imageBytes,
      };
    } catch (err) {
      lastError = err;
      console.error(`[OCR] Attempt ${attempt}/3 failed:`, err.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw lastError;
}
