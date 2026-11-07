// 字元 n-gram 特徵，訓練和線上推論共用，兩邊才不會不一致。
export function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, ' url ')
    .replace(/\d+/g, '0');
}

const WORD = /[\p{L}\p{N}]+/gu;

// 中文用 1 到 3 字元的 n-gram，拉丁文字再補整個單字，不需要斷詞。
export function grams(text) {
  const out = [];
  for (const part of normalize(text).match(WORD) ?? []) {
    const chars = [...part];
    if (/^[\x00-\x7fÀ-ɏḀ-ỿ]+$/.test(part)) out.push(`w:${part}`);
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= chars.length; i++) out.push(chars.slice(i, i + n).join(''));
    }
  }
  return out;
}
