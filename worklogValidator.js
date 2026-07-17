// ── Setup WebSocket ─────────────────────────────
let fetch;
async function loadFetch() {
  fetch = (await import('node-fetch')).default;
}
loadFetch();

export const REQUIRED_KEYWORDS = ["worklog", "summary", "record"];
export const WORKLOG_ALTERNATIVE = ["agentnote", "agentno", "attachment"];
export const MIN_KEYWORD_MATCH = 2;
export const FUZZY_THRESHOLD = 65;
export const PARTIAL_THRESHOLD = 92;
export const MIN_WORD_LENGTH = 4;

export const WORKLOG_TABLE = "worklog_ocr_results";
