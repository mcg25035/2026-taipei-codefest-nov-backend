// 用手寫訓練句做交叉驗證，比較有沒有公開資料的差別並選門檻。不碰 seed/test。
import { CLASSES, readPublic, readSeed } from './data.js';
import { predict, train } from './model.js';

const seed = readSeed('train');
const pub = readPublic(300);
console.log('seed', seed.length, 'public kept', pub.rows.length, 'public raw per class', pub.counts);
const FOLDS = 5;
const folds = Array.from({ length: FOLDS }, () => []);
const byClass = {};
for (const row of seed) (byClass[row.label] ??= []).push(row);
for (const rows of Object.values(byClass)) rows.forEach((r, i) => folds[i % FOLDS].push(r));

function evaluate(name, options, extra) {
  const results = [];
  for (let k = 0; k < FOLDS; k++) {
    const test = folds[k];
    const rows = [...folds.filter((_, i) => i !== k).flat(), ...extra];
    const model = train(rows, CLASSES, options);
    for (const r of test) results.push({ truth: r.label, ...predict(model, r.text) });
  }
  const acc = results.filter((r) => r.truth === r.label).length / results.length;
  const line = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((th) => {
    const auto = results.filter((r) => r.confidence >= th);
    const p = auto.filter((r) => r.truth === r.label).length / (auto.length || 1);
    return `th${th}:cov${(auto.length / results.length).toFixed(2)}/prec${p.toFixed(2)}`;
  }).join(' ');
  console.log(name.padEnd(26), 'acc', acc.toFixed(3), line);
  return results;
}
evaluate('seed only', { epochs: 30 }, []);
evaluate('seed+public seedW4', { epochs: 15, seedWeight: 4 }, pub.rows);
evaluate('seed+public seedW10', { epochs: 15, seedWeight: 10 }, pub.rows);
evaluate('seed+public100 seedW4', { epochs: 15, seedWeight: 4 }, readPublic(100).rows);
