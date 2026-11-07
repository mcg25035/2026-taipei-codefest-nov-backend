import { grams } from './features.js';

// 多類別邏輯迴歸。依賴少、推論只是查表加總。
export function vectorizerFit(rows, minDf = 2) {
  const df = new Map();
  for (const { text } of rows) for (const g of new Set(grams(text))) df.set(g, (df.get(g) ?? 0) + 1);
  const vocab = new Map();
  const idf = [];
  for (const [g, n] of df) {
    if (n < minDf) continue;
    vocab.set(g, idf.length);
    idf.push(Math.log((1 + rows.length) / (1 + n)) + 1);
  }
  return { vocab, idf };
}

export function vectorize(text, vocab, idf) {
  const tf = new Map();
  for (const g of grams(text)) {
    const i = vocab.get(g);
    if (i !== undefined) tf.set(i, (tf.get(i) ?? 0) + 1);
  }
  const entries = [...tf].map(([i, n]) => [i, (1 + Math.log(n)) * idf[i]]);
  const norm = Math.hypot(...entries.map(([, v]) => v)) || 1;
  return entries.map(([i, v]) => [i, v / norm]);
}

export function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function train(rows, classes, { epochs = 30, lr = 1.5, l2 = 1e-5, seedWeight = 4 } = {}) {
  const { vocab, idf } = vectorizerFit(rows);
  const C = classes.length;
  const weights = new Float64Array(vocab.size * C);
  const bias = new Float64Array(C);
  const counts = classes.map((c) => rows.filter((r) => r.label === c).reduce((a, r) => a + (r.source === 'seed' ? seedWeight : 1), 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const classWeight = counts.map((n) => total / (C * Math.max(n, 1)));
  const samples = rows.map((r) => ({
    x: vectorize(r.text, vocab, idf), y: classes.indexOf(r.label), w: (r.source === 'seed' ? seedWeight : 1),
  }));
  let s = 7;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let epoch = 0; epoch < epochs; epoch++) {
    const rate = lr / (1 + epoch * 0.1);
    for (let i = samples.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [samples[i], samples[j]] = [samples[j], samples[i]]; }
    for (const { x, y, w } of samples) {
      const scores = bias.slice();
      for (const [i, v] of x) for (let c = 0; c < C; c++) scores[c] += weights[i * C + c] * v;
      const p = softmax([...scores]);
      const sw = w * classWeight[y] * rate;
      for (let c = 0; c < C; c++) {
        const g = (c === y ? 1 : 0) - p[c];
        bias[c] += sw * g * 0.1;
        for (const [i, v] of x) weights[i * C + c] += sw * (g * v - l2 * weights[i * C + c]);
      }
    }
  }
  return { classes, vocab, idf, weights, bias };
}

export function predict(model, text) {
  const C = model.classes.length;
  const x = vectorize(text, model.vocab, model.idf);
  const scores = [...model.bias];
  for (const [i, v] of x) for (let c = 0; c < C; c++) scores[c] += model.weights[i * C + c] * v;
  const probs = softmax(scores);
  let best = 0;
  for (let c = 1; c < C; c++) if (probs[c] > probs[best]) best = c;
  return { label: model.classes[best], confidence: probs[best], probs, known: x.length };
}
