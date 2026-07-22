// parser.js
// Mengubah teks capture (format free-text dengan label) menjadi object terstruktur.
// Mendukung 4 format: Binding, GNO/REGFAIL/PELLPAS, Routing, OG NOK.

// ─────────────────────────────────────────────
// FIELD DEFINITIONS PER FORMAT
// ─────────────────────────────────────────────

const BINDING_FIELDS = [
  { key: "no_tiket",        regex: /No\s*Tiket\s*:\s*/i,                                              singleLine: true },
  { key: "no_service",      regex: /No\s*Service\s*:\s*/i,                                            singleLine: true },
  // ponytail: typo tolerance — LID LAMA, CLDI LAMA, CLIID LAMA, etc
  { key: "clid_lama",       regex: /C?L[ID]{1,2}\s*LAMA\s*:\s*/i,                                    singleLine: true },
  { key: "clid_baru",       regex: /C?L[ID]{1,2}\s*BARU\s*:\s*/i,                                    singleLine: true },
  { key: "domain",          regex: /Domain\s*:\s*/i,                                                  singleLine: true },
  // ponytail: alasnan, alasna, alasna typo variants covered by \w* between letters
  { key: "alasan_binding",  regex: /(?:^|\n)[ \t]*(?:Alas[a-z]*\s*Binding|Alas[a-z]*|Keterangan|Ket\.?)\s*:/im },
];

const GNO_FIELDS = [
  { key: "capture",         regex: /Capture\s*:\s*/i,                                                 singleLine: true },
  { key: "no_tiket",        regex: /No\s*Tiket\s*:\s*/i,                                              singleLine: true },
  { key: "no_service",      regex: /No\s*Service\s*:\s*/i,                                            singleLine: true },
  // GNO wajib "Keterangan, Password:" — tanpa ", Password" bukan GNO
  { key: "keterangan",      regex: /Keterangan\s*[,&\/]\s*Password\s*:\s*/i },
];

const ROUTING_FIELDS = [
  { key: "capture",         regex: /Capture\s*:\s*/i,                                                 singleLine: true },
  { key: "no_tiket",        regex: /No\s*Tiket\s*:\s*/i,                                              singleLine: true },
  { key: "no_service",      regex: /No\s*Service\s*:\s*/i,                                            singleLine: true },
  // "Ket. GPON/MSAN:" atau "Ket GPON/MSAN:" atau "Ket. GPON:" dll
  { key: "ket_gpon_msan",   regex: /Ket\.?\s*GPON(?:\/MSAN)?\s*:\s*/i },
];

const OGNOK_FIELDS = [
  { key: "capture",         regex: /Capture\s*:\s*/i,                                                 singleLine: true },
  { key: "no_tiket",        regex: /No\s*Tiket\s*:\s*/i,                                              singleLine: true },
  { key: "no_service",      regex: /No\s*Service\s*:\s*/i,                                            singleLine: true },
  // "Keterangan:" saja (tanpa ", Password" atau "GPON/MSAN")
  { key: "keterangan",      regex: /Keterangan\s*:\s*/i },
];

// ─────────────────────────────────────────────
// FORMAT DETECTOR
// Urutan pengecekan penting: yang paling spesifik dulu.
// ─────────────────────────────────────────────

const FORMAT_SIGNATURES = [
  { formatType: "binding",  regex: /Alasan\s*Binding\s*:/i },
  { formatType: "binding",  regex: /CLID\s*LAMA\s*:/i },
  // "Alasan :" tanpa kata Binding — valid jika ada CLID LAMA juga (dicek via CLID_LAMA di atas)
  // Didaftarkan sebelum gno/ognok agar tidak salah tangkap
  { formatType: "binding",  regex: /(?:^|\n)\s*Alasan\s*:/im },
  { formatType: "gno",      regex: /Keterangan\s*[,&\/]\s*Password\s*:/i },
  // ponytail: Keterangan: + gno/regfail keyword → detect as GNO (invalid), not OG NOK
  { formatType: "gno",      test: (t) => /Keterangan\s*:/i.test(t) && /\b(gno|regfail|pellpas)\b/i.test(t) },
  { formatType: "routing",  regex: /Ket\.?\s*GPON(?:\/MSAN)?\s*:/i },
  // ponytail: Keterangan: + routing keyword → detect as Routing (invalid), not OG NOK
  { formatType: "routing",  test: (t) => /Keterangan\s*:/i.test(t) && /\b(routing|reroute|gpon|msan)\b/i.test(t) },
  { formatType: "ognok",    regex: /Keterangan\s*:/i },
];

function detectFormat(text) {
  for (const sig of FORMAT_SIGNATURES) {
    if (sig.test ? sig.test(text) : sig.regex.test(text)) return sig.formatType;
  }
  return null;
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function stripMarkdownLink(value) {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}

const EMPTY_MARKERS = ["required", "optional", "capture / required", "capture / optional", "wajib", "-", ""];

function normalizeForEmptyCheck(value) {
  return value
    .trim()
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .trim()
    .toLowerCase();
}

function stripInstructionalHeaders(text) {
  let inlineDomain = null;
  let hasClidHeader = false;

  // Hanya hapus baris instruksional "CLID lama, CLID baru, Domain: ..."
  // BUKAN baris data seperti "CLID LAMA: GPON 1 - A - B - 1"
  const cleaned = text.replace(
    /^[ \t]*CLID\s*lama\s*[,，]\s*CLID\s*baru\b[^\n]*/im,
    (match) => {
      hasClidHeader = true;
      // Extract domain inline dari baris ini sebagai fallback
      const domainMatch = match.match(/Domain\s*:\s*(.+)/i);
      if (domainMatch) {
        inlineDomain = stripMarkdownLink(domainMatch[1]);
        if (!inlineDomain) inlineDomain = null;
      }
      return ""; // hapus seluruh baris header
    }
  );

  return { cleaned, inlineDomain, hasClidHeader };
}

const CLID_FORMAT_REGEX = /^GPON\s*\d+\s*-\s*[A-Za-z0-9]+\s*-\s*([A-Za-z]+)\s*-\s*\d+/i;

function parseClid(clidValue) {
  if (!clidValue) return { valid: false, sto: null };
  const match = CLID_FORMAT_REGEX.exec(clidValue.trim());
  if (!match) return { valid: false, sto: null };
  return { valid: true, sto: match[1].toUpperCase() };
}

const LAPSUNG_ALIASES = ["lapsung", "langsung"];
const CONTAINS_DIGIT = /\d/;

function parseNoTiket(rawNoTiket) {
  if (!rawNoTiket) return { jenis: null, nomor_tiket: null };

  const normalized = rawNoTiket.trim().toLowerCase();

  if (LAPSUNG_ALIASES.includes(normalized)) {
    return { jenis: "Lapsung", nomor_tiket: null };
  } else if (CONTAINS_DIGIT.test(rawNoTiket)) {
    return { jenis: "Tiket", nomor_tiket: rawNoTiket };
  } else {
    const jenis = rawNoTiket
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return { jenis, nomor_tiket: null };
  }
}

// ─────────────────────────────────────────────
// GENERIC FIELD EXTRACTOR
// ─────────────────────────────────────────────

function extractFields(text, fieldDefs) {
  const matches = [];

  for (const field of fieldDefs) {
    const m = field.regex.exec(text);
    if (m) {
      matches.push({
        key: field.key,
        start: m.index,
        end: m.index + m[0].length,
        singleLine: field.singleLine === true,
      });
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => a.start - b.start);

  const result = {};
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let value = stripMarkdownLink(text.slice(start, end));

    // Field single-line: hanya ambil sampai akhir baris pertama.
    // Teks setelah newline (GANTI ONT, SN LAMA, dll) diabaikan di sini
    // dan akan tertangkap oleh field berikutnya (biasanya alasan_binding).
    if (matches[i].singleLine) {
      value = value.split(/\r?\n/)[0];
    }

    if (EMPTY_MARKERS.includes(normalizeForEmptyCheck(value))) value = null;
    result[matches[i].key] = value || null;
  }

  return result;
}

// ─────────────────────────────────────────────
// FORMAT-SPECIFIC PARSERS
// ─────────────────────────────────────────────

// Ekstrak semua teks "ekstra" yang posisinya di antara baris pertama No Service
// dan label CLID LAMA. Apapun isinya (GANTI ONT, GANTI GPI, FD LAMA/BARU,
// SN LAMA/BARU, catatan bebas, dll) akan tertangkap dan di-append ke alasan_binding.
// Pendekatan berbasis posisi — tidak bergantung pada keyword perangkat tertentu.
function extractExtraBlock(text) {
  // Temukan akhir baris pertama setelah "No Service:"
  const noServiceMatch = /No\s*Service\s*:\s*[^\n]*/i.exec(text);
  if (!noServiceMatch) return null;
  const afterNoService = noServiceMatch.index + noServiceMatch[0].length;

  // Temukan awal label "CLID LAMA:"
  const clidLamaMatch = /\bCLID\s*LAMA\s*:/i.exec(text);
  if (!clidLamaMatch) return null;
  const beforeClidLama = clidLamaMatch.index;

  if (afterNoService >= beforeClidLama) return null;

  // Ambil semua teks di antara keduanya, buang baris kosong, trim
  const block = text.slice(afterNoService, beforeClidLama)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join("\n");

  return block || null;
}

function normalizeDomain(raw) {
  if (!raw) return null;
  const v = raw.trim();
  return v.startsWith("@") ? v : `@${v}`;
}

function parseBinding(text) {
  const { cleaned, inlineDomain, hasClidHeader } = stripInstructionalHeaders(text);

  // Tangkap blok ekstra (apapun isinya) antara No Service dan CLID LAMA
  const extraBlock = extractExtraBlock(cleaned);

  const raw = extractFields(cleaned, BINDING_FIELDS);
  if (!raw) return null;

  // Jika baris eksplisit "Domain: @telkom.net" ada → pakai itu (sudah di raw.domain)
  // Jika tidak ada → fallback ke domain yang ada di baris header deskriptif
  if (!raw.domain && inlineDomain) {
    raw.domain = inlineDomain;
  }

  // Pastikan domain diawali "@"
  if (raw.domain) raw.domain = normalizeDomain(raw.domain);

  // Trim nilai multiline (bersihkan newline berlebih di akhir tiap field)
  for (const k of Object.keys(raw)) {
    if (typeof raw[k] === "string") raw[k] = raw[k].trim().replace(/\n+$/, "") || null;
  }

  // Jika ada blok ekstra antara No Service dan CLID LAMA, append ke alasan_binding.
  // Baris yang sudah ada di alasan_binding (case-insensitive, strip trailing ":") dilewati.
  if (extraBlock) {
    // Normalisasi untuk dedup: lowercase + hapus trailing ":" dan spasi
    const normalize = (l) => l.trim().toLowerCase();

    const existingNorms = raw.alasan_binding
      ? raw.alasan_binding.split(/\r?\n/).map(normalize)
      : [];

    // Filter baris dari extraBlock:
    // - Buang jika sudah ada persis di alasan_binding (case-insensitive)
    // - Buang jika existing line adalah prefix dari baris ini
    //   (misal "MIGRASI" sudah ada → "MIGRASI LAYANAN :" dibuang)
    const newLines = extraBlock
      .split(/\r?\n/)
      .filter(l => {
        const norm = normalize(l);
        if (!norm) return false;
        return !existingNorms.some(ex => norm === ex || norm.startsWith(ex));
      });

    if (newLines.length > 0) {
      raw.alasan_binding = raw.alasan_binding
        ? `${raw.alasan_binding}\n${newLines.join("\n")}`
        : newLines.join("\n");
    }
  }

  const rawNoTiket = raw.no_tiket;
  delete raw.no_tiket;

  const { jenis, nomor_tiket } = parseNoTiket(rawNoTiket);
  raw.jenis = jenis;
  raw.nomor_tiket = nomor_tiket;

  const clidLamaInfo = parseClid(raw.clid_lama);
  const clidBaruInfo = parseClid(raw.clid_baru);
  raw.sto_lama = clidLamaInfo.sto || null;
  raw.sto_baru = clidBaruInfo.sto || null;

  const isValid =
    Boolean(rawNoTiket) &&
    Boolean(raw.no_service) &&
    hasClidHeader &&
    Boolean(raw.clid_lama) &&
    Boolean(raw.clid_baru) &&
    Boolean(raw.domain) &&
    Boolean(raw.alasan_binding);

  let invalidReason = null;
  if (!isValid && !rawNoTiket) invalidReason = "missing_no_tiket";

  return { data: raw, isValid, invalidReason };
}

function parseGno(text) {
  const raw = extractFields(text, GNO_FIELDS);
  if (!raw) return null;

  const rawNoTiket = raw.no_tiket;
  delete raw.no_tiket;

  const { jenis, nomor_tiket } = parseNoTiket(rawNoTiket);
  raw.jenis = jenis;
  raw.nomor_tiket = nomor_tiket;

  const isValid =
    Boolean(rawNoTiket) &&
    Boolean(raw.no_service) &&
    Boolean(raw.keterangan);

  const invalidReason = !isValid
    ? (!rawNoTiket ? "missing_no_tiket" : !raw.no_service ? "missing_no_service" : "missing_keterangan")
    : null;

  return { data: raw, isValid, invalidReason };
}

function parseRouting(text) {
  const raw = extractFields(text, ROUTING_FIELDS);
  if (!raw) return null;

  const rawNoTiket = raw.no_tiket;
  delete raw.no_tiket;

  const { jenis, nomor_tiket } = parseNoTiket(rawNoTiket);
  raw.jenis = jenis;
  raw.nomor_tiket = nomor_tiket;

  const isValid =
    Boolean(rawNoTiket) &&
    Boolean(raw.no_service) &&
    Boolean(raw.ket_gpon_msan);

  const invalidReason = !isValid
    ? (!rawNoTiket ? "missing_no_tiket" : !raw.no_service ? "missing_no_service" : "missing_ket_gpon_msan")
    : null;

  return { data: raw, isValid, invalidReason };
}

function parseOgnok(text) {
  const raw = extractFields(text, OGNOK_FIELDS);
  if (!raw) return null;

  const rawNoTiket = raw.no_tiket;
  delete raw.no_tiket;

  const { jenis, nomor_tiket } = parseNoTiket(rawNoTiket);
  raw.jenis = jenis;
  raw.nomor_tiket = nomor_tiket;

  const isValid =
    Boolean(rawNoTiket) &&
    Boolean(raw.no_service) &&
    Boolean(raw.keterangan);

  const invalidReason = !isValid
    ? (!rawNoTiket ? "missing_no_tiket" : !raw.no_service ? "missing_no_service" : "missing_keterangan")
    : null;

  return { data: raw, isValid, invalidReason };
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

/**
 * Deteksi format & parse capture text secara otomatis.
 *
 * Return:
 *   null  → teks tidak cocok format manapun
 *   { formatType, data, isValid, invalidReason }
 *
 * formatType: "binding" | "gno" | "routing" | "ognok"
 */
// ─────────────────────────────────────────────
// TYPO NORMALIZER
// ponytail: regex replacements for common 1-2 char typos on field labels.
// ceiling: won't catch semantic errors or completely garbled words; upgrade to
//          fuzzy match lib (fuse.js) if more exotic typos appear in production.
// ─────────────────────────────────────────────
function normalizeTypos(text) {
  return text
    // CLID LAMA/BARU — LID, CLDI, CLIID, CLID (any 1-2 char transposition)
    .replace(/\bC?L[ID]{1,3}\s*LAMA\s*:/gi, 'CLID LAMA :')
    .replace(/\bC?L[ID]{1,3}\s*BARU\s*:/gi, 'CLID BARU :')
    // DOMAIN — dmain, doman, doamin, domian, dmoin
    .replace(/\bD[OAIM]{1,4}N\s*:/gi, 'Domain :')
    // NO TIKET — no tieket, no tikct, no tket, no tiiket, no tiket
    .replace(/\bNo\.?\s*Ti[a-z]{2,6}\s*:/gi, 'No Tiket :')
    // NO SERVICE — no servce, no servis, no srevice, no sevrice
    .replace(/\bNo\.?\s*S[a-z]{4,9}\s*:/gi, (m) =>
      /s.{0,2}r.{0,2}v/i.test(m) ? 'No Service :' : m
    )
    // ALASAN BINDING — alasnan bining, alsan binding, alasan bnding, alsaan binidng, asan binding, alasan bnding dll
    .replace(/\bA[a-z]{2,8}\s*B?n?[ia]?[dn][a-z]*\s*:/gi, 'Alasan Binding :')
    // ALASAN alone
    .replace(/\bAlas[a-z]+\s*:/gi, (m) => /bin/i.test(m) ? m : 'Alasan :')
    // KETERANGAN, PASSWORD — ketrangan, keteranagan, etc
    .replace(/\bKet[a-z]*\s*[,&\/]\s*Pass[a-z]*\s*:/gi, 'Keterangan, Password :')
    // KETERANGAN alone
    .replace(/\bKet[a-z]{4,10}\s*:/gi, 'Keterangan :')
    // KET. GPON/MSAN — ket gpon, keterangan gpon/msan, ket. gpon msan
    .replace(/\bKet[a-z]*\.?\s*GPON[/\s]?(?:MSAN)?\s*:/gi, 'Ket. GPON/MSAN :');
}

export function parseCaptureText(rawText) {
  const text = normalizeTypos(rawText);
  const formatType = detectFormat(text);
  if (!formatType) return null;

  let result = null;

  switch (formatType) {
    case "binding": result = parseBinding(text); break;
    case "gno":     result = parseGno(text);     break;
    case "routing": result = parseRouting(text); break;
    case "ognok":   result = parseOgnok(text);   break;
  }

  if (!result) return null;

  return { formatType, ...result };
}
