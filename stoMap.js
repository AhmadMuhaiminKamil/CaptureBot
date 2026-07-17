// stoMap.js — Map no_service ke STO dari file Excel prefix
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Coba load dari beberapa lokasi (lokal WSL, project root, dll)
const CANDIDATE_PATHS = [
  '/mnt/c/users/asus/merged-project/NEW PREFIX NUMBER POTS & INET JAKTIM.xlsx',
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'NEW PREFIX NUMBER POTS & INET JAKTIM.xlsx'),
];

let stoMap = null;

function loadStoMap() {
  if (stoMap) return stoMap;

  // Cari file excel yang ada
  let excelPath = null;
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) { excelPath = p; break; }
  }

  if (!excelPath) {
    console.warn('[STO Map] File excel prefix tidak ditemukan — STO mapping disabled');
    stoMap = new Map(); // empty map, no crash
    return stoMap;
  }

  try {
    const wb = XLSX.readFile(excelPath);
    const ws = wb.Sheets['pref_num_pots'];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

    stoMap = new Map();
    for (const r of data) {
      const pref = String(r.PREF).trim();
      const pref2 = String(r.PREF2).trim();
      const sto = String(r.STO).trim().toUpperCase();
      if (pref && sto) stoMap.set('p_' + pref, sto);
      if (pref2 && sto) stoMap.set('p2_' + pref2, sto);
    }
    console.log(`[STO Map] Loaded ${data.length} rows from ${excelPath}`);
  } catch (err) {
    console.error('[STO Map] Gagal load excel:', err.message);
    stoMap = new Map();
  }
  return stoMap;
}

/**
 * Cari STO dari nomor service.
 * @param {string} noService - nomor service (contoh: '021166' atau '166')
 * @returns {string|null} kode STO (contoh: 'JTN') atau null jika tidak ketemu
 */
export function findSto(noService) {
  if (!noService) return null;
  const map = loadStoMap();

  // Hapus '021' di depan jika ada
  let num = String(noService).trim();
  if (num.startsWith('021')) num = num.slice(3);

  // Cari prefix terpanjang dulu untuk akurasi maksimal
  for (let len = num.length; len >= 1; len--) {
    const prefix = num.slice(0, len);
    let sto = map.get('p_' + prefix);
    if (sto) return sto;
    sto = map.get('p2_' + prefix);
    if (sto) return sto;
  }
  return null;
}
