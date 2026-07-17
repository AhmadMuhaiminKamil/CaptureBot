// stoMap.js — Map no_service ke STO (tanpa file excel, pake JS module)
import { PREF2_MAP, PREF_MAP } from "./stoMapData.js";

/**
 * Cari STO dari nomor service.
 * @param {string} noService - nomor service (contoh: '021166' atau '166')
 * @returns {string|null} kode STO (contoh: 'JTN') atau null jika tidak ketemu
 */
export function findSto(noService) {
  if (!noService) return null;

  // Hapus '021' di depan jika ada
  let num = String(noService).trim();
  if (num.startsWith('021')) num = num.slice(3);

  // Cari prefix terpanjang dulu untuk akurasi maksimal
  for (let len = num.length; len >= 1; len--) {
    const prefix = num.slice(0, len);
    let sto = PREF2_MAP[prefix];
    if (sto) return sto;
    sto = PREF_MAP[prefix];
    if (sto) return sto;
  }
  return null;
}
