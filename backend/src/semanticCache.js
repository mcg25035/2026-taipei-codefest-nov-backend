import { newId, nowIso } from './util.js';

const BOT_ID = 'u_semantic_cache_bot';
export const RESERVED_ID_PREFIX = 'system:';

const toBlob = (vector) => Buffer.from(Float32Array.from(vector).buffer);
const fromBlob = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const httpEmbedder = (baseUrl) => ({
  async embed(text) {
    const res = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`embedding service returned ${res.status}`);
    return (await res.json()).vector;
  },
});

const questionText = (row) => [row.title_is_auto ? null : row.title, row.body].filter((s) => s?.trim()).join('\n')
  || (row.title_is_auto && row.body ? row.body : '');

// 新問題和已採納的解答夠像時，由機器人貼上舊解答。這是輔助，任何錯誤都不可影響發問。
export function createSemanticCache({ db, config, notifier, getRealtime }) {
  const embedder = config.embedderOverride ?? (config.embeddingUrl ? httpEmbedder(config.embeddingUrl) : null);
  const inFlight = new Set();
  const track = (promise) => {
    const p = promise.catch((err) => console.warn(`semantic cache: ${err.message}`)).finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  };

  if (embedder) {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, townpass_user_id, nickname, languages, role, created_at)
      VALUES (?, ?, '城市通小幫手', '[]', 'bot', ?)
    `).run(BOT_ID, `${RESERVED_ID_PREFIX}semantic-cache-bot`, nowIso());
  }

  const saveVector = db.prepare('INSERT OR REPLACE INTO question_embeddings (question_id, vector) VALUES (?, ?)');
  const candidates = db.prepare(`
    SELECT q.id AS question_id, a.id AS answer_id, a.body, a.language, e.vector
    FROM question_embeddings e
    JOIN questions q ON q.id = e.question_id
    JOIN answers a ON a.id = q.accepted_answer_id
    WHERE q.id != ? AND a.body IS NOT NULL AND TRIM(a.body) != ''
      AND NOT EXISTS (
        SELECT 1 FROM pii_reports r WHERE r.status = 'pending' AND (
          (r.target_type = 'answer' AND r.target_id = a.id) OR (r.target_type = 'question' AND r.target_id = q.id)
        )
      )
  `);
  const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const insertAnswer = db.prepare(`
    INSERT INTO answers (id, question_id, author_id, body, language, cached_from_question_id, cached_from_answer_id, cached_similarity, created_at)
    VALUES (@id, @question_id, @author_id, @body, @language, @source_question, @source_answer, @similarity, @created_at)
  `);
  const bumpCount = db.prepare('UPDATE questions SET answer_count = answer_count + 1 WHERE id = ?');
  const missingVectors = db.prepare(`
    SELECT q.* FROM questions q LEFT JOIN question_embeddings e ON e.question_id = q.id
    WHERE e.question_id IS NULL AND q.body IS NOT NULL AND TRIM(q.body) != '' LIMIT 20
  `);

  const findMatch = (questionId, vector) => {
    let best = null;
    for (const row of candidates.iterate(questionId)) {
      const similarity = dot(vector, fromBlob(row.vector));
      if (!best || similarity > best.similarity) best = { ...row, similarity };
    }
    return best && best.similarity >= config.semanticCacheThreshold ? best : null;
  };

  async function handleNewQuestion(question) {
    const text = questionText(question);
    if (!text) return;
    const vector = await embedder.embed(text);
    // 計算期間問題可能已被撤回。
    if (!questionById.get(question.id)) return;
    saveVector.run(question.id, toBlob(vector));
    const match = findMatch(question.id, Float32Array.from(vector));
    if (!match) return;

    db.transaction(() => {
      insertAnswer.run({
        id: newId('a'),
        question_id: question.id,
        author_id: BOT_ID,
        body: `這個問題之前有人問過，以下是當時被採納的解答，僅供參考：\n\n${match.body}`,
        language: match.language,
        source_question: match.question_id,
        source_answer: match.answer_id,
        similarity: match.similarity,
        created_at: nowIso(),
      });
      bumpCount.run(question.id);
    })();
    notifier.create({
      userId: question.author_id,
      type: 'new_answer',
      title: '小幫手找到類似問題的解答',
      body: notifier.questionLabel(question),
      questionId: question.id,
    });
    getRealtime().answersChanged(question.id);
    getRealtime().questionChanged(question.id);
    getRealtime().feedChanged();
  }

  // 模型服務沒開時建立的問題，等服務恢復後補算，舊問題才找得到。
  async function backfill() {
    for (const row of missingVectors.all()) {
      const text = questionText(row);
      if (text) saveVector.run(row.id, toBlob(await embedder.embed(text)));
    }
  }
  const timer = embedder ? setInterval(() => track(backfill()), config.embeddingBackfillMs) : null;
  timer?.unref();
  if (embedder) setImmediate(() => track(backfill()));

  return {
    enabled: Boolean(embedder),
    questionCreated(question) {
      if (embedder) track(handleNewQuestion(question));
    },
    async idle() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    async close() {
      clearInterval(timer);
      await this.idle();
    },
  };
}
