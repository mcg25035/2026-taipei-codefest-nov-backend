// 用沒參與訓練的 seed/test 評估已輸出的模型。
import { createClassifier } from '../src/classifier.js';
import { CLASSES, readSeed } from './data.js';

const clf = createClassifier();
const test = readSeed('test');
const results = test.map((r) => ({ ...r, ...clf.classify(r.text) }));
const correct = results.filter((r) => r.predicted === r.label).length;
const auto = results.filter((r) => r.category !== 'uncategorized');
const autoOk = auto.filter((r) => r.category === r.label).length;
const n = test.length;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const ci = (k, t) => { const p = k / t; const m = 1.96 * Math.sqrt(p * (1 - p) / t); return `${pct(p)} (±${(m * 100).toFixed(1)})`; };
console.log(`test sentences ${n}; always-most-common baseline ${pct(Math.max(...CLASSES.map((c) => test.filter((r) => r.label === c).length)) / n)}`);
console.log(`top-1 accuracy, forced guess: ${ci(correct, n)}`);
console.log(`threshold ${clf.threshold}: auto-classified ${auto.length}/${n} (${pct(auto.length / n)}), precision ${ci(autoOk, auto.length)}`);
console.log(`sent to volunteers ${n - auto.length}; wrong auto labels ${auto.length - autoOk}`);
for (const c of CLASSES) {
  const rows = results.filter((r) => r.label === c);
  const a = rows.filter((r) => r.category !== 'uncategorized');
  const errs = {};
  rows.filter((r) => r.predicted !== c).forEach((r) => { errs[r.predicted] = (errs[r.predicted] ?? 0) + 1; });
  console.log(c.padEnd(18), `recall ${rows.filter((r) => r.predicted === c).length}/${rows.length}`, `auto-ok ${a.filter((r) => r.category === c).length}, auto-wrong ${a.filter((r) => r.category !== c).length}, volunteer ${rows.length - a.length}`, JSON.stringify(errs));
}
console.log('--- wrong auto labels');
for (const r of auto.filter((x) => x.category !== x.label)) console.log(`${r.label} -> ${r.category} ${r.confidence.toFixed(2)} | ${r.text}`);
console.log('--- scam missed');
for (const r of results.filter((x) => x.label === 'scam_check' && x.category !== 'scam_check')) console.log(`${r.category} ${r.predicted} ${r.confidence.toFixed(2)} | ${r.text}`);
const t0 = process.hrtime.bigint();
for (let i = 0; i < 1000; i++) clf.classify(test[i % n].text);
console.log(`latency ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(3)} ms per classify (1000 runs)`);
