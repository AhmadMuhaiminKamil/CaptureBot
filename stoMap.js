// stoMap.js — Map no_service ke STO dari file Excel prefix
import XLSX from 'xlsx';
import path from 'path';

const EXCEL_PATH = path.resolve('/mnt/c/users/asus/merged-project/NEW PREFIX NUMBER POTS & INET JAKTIM.xlsx');

let stoMap = null;

function loadStoMap() {
  if (stoMap) return stoMap;
  const wb = XLSX.readFile(EXCEL_PATH);
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
  console.log(`[STO Map] Loaded ${data.length} rows from excel`);
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
