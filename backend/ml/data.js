import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLASSES = ['map_navigation', 'admin_procedure', 'document_contract', 'scam_check', 'app_usage', 'language', 'other'];
const here = path.dirname(fileURLToPath(import.meta.url));

export const readSeed = (split) => CLASSES.flatMap((label) => (
  fs.readFileSync(path.join(here, 'seed', split, `${label}.txt`), 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .map((text) => ({ text, label, source: 'seed' }))
));

// 用關鍵字替公開資料產生弱標籤，順序代表優先權。只看標題，因為內文是官方回答。
const WEAK_RULES = [
  ['scam_check', /詐騙|騙/],
  ['app_usage', /app|帳號|密碼|登入|網路|線上|網站|系統|下載|手機|憑證|行動支付|e化|電子/i],
  ['document_contract', /合約|契約|租約|通知書|罰單|公文|繳款書|條款|同意書|報告|裁決書|處分書/],
  ['map_navigation', /位置|地址|怎麼去|如何前往|路線|在哪|地圖|交通方式|到達|站牌|出口|停車場/],
  ['language', /翻譯|外語|英文|外籍|中文|語言/],
  ['admin_procedure', /申請|申辦|補助|辦理|證明|登記|請領|資格|繳納|需要.*(文件|證件)|手續|流程|補發/],
];

function readFaq() {
  const rows = JSON.parse(fs.readFileSync(path.join(here, 'data/taipei-faq.json'), 'utf8').replace(/^﻿/, ''));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const text = String(row.title ?? '').trim();
    if (text.length < 4 || text.length > 80 || seen.has(text)) continue;
    seen.add(text);
    const rule = WEAK_RULES.find(([, re]) => re.test(text));
    // 其餘主題（衛生、勞動法規等）不屬於前面任何一類的問句，當作 other。
    const label = rule ? rule[0] : (/[？?]|嗎|如何|怎麼|為何|什麼/.test(text) ? 'other' : null);
    if (label) out.push({ text, label, source: 'faq' });
  }
  return out;
}

function readScam165() {
  const raw = fs.readFileSync(path.join(here, 'data/scam165.csv'), 'utf8').replace(/^﻿/, '');
  const titles = [...raw.matchAll(/^\d+,"?([^",\n]{4,80})"?,\d{4}\//gm)].map((m) => m[1].trim());
  return titles.map((text) => ({ text, label: 'scam_check', source: '165' }));
}

function seededShuffle(items, seed = 42) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 每類最多取一定筆數，避免模型一面倒猜「行政程序」。
export function readPublic(maxPerClass = 300) {
  const counts = {};
  const kept = [];
  for (const row of seededShuffle([...readFaq(), ...readScam165()])) {
    counts[row.label] = (counts[row.label] ?? 0) + 1;
    if (counts[row.label] <= maxPerClass) kept.push(row);
  }
  return { rows: kept, counts };
}
