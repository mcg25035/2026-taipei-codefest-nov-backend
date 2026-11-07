import { CLASSES, readPublic, readSeed } from './data.js';
import { predict, train } from './model.js';
const seed = readSeed('train');
console.log('seed', seed.length);
const FOLDS = 5;
const folds = Array.from({ length: FOLDS }, () => []);
const byClass = {};
for (const row of seed) (byClass[row.label] ??= []).push(row);
for (const rows of Object.values(byClass)) rows.forEach((r, i) => folds[i % FOLDS].push(r));
function evaluate(name, options, extra, confusion = false) {
  const results = [];
  for (let k = 0; k < FOLDS; k++) {
    const rows = [...folds.filter((_, i) => i !== k).flat(), ...extra];
    const model = train(rows, CLASSES, options);
    for (const r of folds[k]) results.push({ truth: r.label, text: r.text, ...predict(model, r.text) });
  }
  const acc = results.filter((r) => r.truth === r.label).length / results.length;
  const line = [0.5, 0.6, 0.7, 0.8].map((th) => {
    const auto = results.filter((r) => r.confidence >= th);
    return `th${th}:cov${(auto.length / results.length).toFixed(2)}/prec${(auto.filter((r) => r.truth === r.label).length / (auto.length || 1)).toFixed(2)}`;
  }).join(' ');
  console.log(name.padEnd(30), 'acc', acc.toFixed(3), line);
  if (confusion) for (const c of CLASSES) {
    const rows = results.filter((r) => r.truth === c);
    const errs = {};
    rows.filter((r) => r.label !== c).forEach((r) => { errs[r.label] = (errs[r.label] ?? 0) + 1; });
    console.log(' ', c.padEnd(18), `recall ${(rows.filter((r) => r.label === c).length / rows.length).toFixed(2)}`, JSON.stringify(errs));
  }
}
const p100 = readPublic(100).rows, p200 = readPublic(200).rows;
evaluate('seed only', { epochs: 30 }, []);
evaluate('pub100 w4 lr1.5', { epochs: 15, seedWeight: 4 }, p100, true);
evaluate('pub100 w4 lr3', { epochs: 15, seedWeight: 4, lr: 3 }, p100);
evaluate('pub100 w8 lr1.5', { epochs: 15, seedWeight: 8 }, p100);
evaluate('pub200 w4 lr1.5', { epochs: 12, seedWeight: 4 }, p200);
evaluate('pub100 w4 l2 1e-4', { epochs: 15, seedWeight: 4, l2: 1e-4 }, p100);
