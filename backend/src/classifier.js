import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grams } from '../ml/features.js';

const modelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../ml/model.json');

// 只做查表加總，不需要 GPU，也不會把文字送到外部服務。
export function createClassifier(file = modelPath) {
  const model = JSON.parse(fs.readFileSync(file, 'utf8'));
  const featureMap = new Map(Object.entries(model.features));
  const C = model.classes.length;

  return {
    threshold: model.threshold,
    classify(text) {
      const tf = new Map();
      for (const g of grams(text)) if (featureMap.has(g)) tf.set(g, (tf.get(g) ?? 0) + 1);
      const scores = [...model.bias];
      const entries = [...tf].map(([g, n]) => {
        const [idf, weights] = featureMap.get(g);
        return { value: (1 + Math.log(n)) * idf, weights };
      });
      const norm = Math.hypot(...entries.map((e) => e.value)) || 1;
      for (const { value, weights } of entries) {
        for (let c = 0; c < C; c++) scores[c] += weights[c] * (value / norm);
      }
      const max = Math.max(...scores);
      const exps = scores.map((s) => Math.exp(s - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      const ranked = model.classes
        .map((category, c) => ({ category, score: Number((exps[c] / sum).toFixed(4)) }))
        .sort((a, b) => b.score - a.score);
      const known = entries.length > 0;
      const top = ranked[0];
      return {
        category: known && top.score >= model.threshold ? top.category : 'uncategorized',
        predicted: top.category,
        confidence: top.score,
        scores: ranked,
      };
    },
  };
}
