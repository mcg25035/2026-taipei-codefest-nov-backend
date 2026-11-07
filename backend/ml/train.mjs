// 訓練最終模型並輸出 ml/model.json。設定由 tune.mjs 的交叉驗證決定，不看 seed/test。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES, readPublic, readSeed } from './data.js';
import { train } from './model.js';

export const THRESHOLD = 0.7;
const here = path.dirname(fileURLToPath(import.meta.url));
const rows = [...readSeed('train'), ...readPublic(200).rows];
const model = train(rows, CLASSES, { epochs: 12, seedWeight: 4 });
const C = CLASSES.length;
const PRUNE = 0.01;
const features = {};
let kept = 0;
for (const [gram, i] of model.vocab) {
  const w = [];
  let any = false;
  for (let c = 0; c < C; c++) {
    const v = model.weights[i * C + c];
    w.push(Math.abs(v) >= PRUNE ? Number(v.toFixed(3)) : 0);
    any ||= Math.abs(v) >= PRUNE;
  }
  if (any) { features[gram] = [Number(model.idf[i].toFixed(3)), w]; kept++; }
}
const out = {
  version: 1,
  trained_at: new Date().toISOString(),
  threshold: THRESHOLD,
  classes: CLASSES,
  bias: [...model.bias].map((b) => Number(b.toFixed(3))),
  features,
};
const file = path.join(here, 'model.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`rows ${rows.length}, features ${kept}, ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
