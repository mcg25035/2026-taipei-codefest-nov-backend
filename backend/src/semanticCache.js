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
    SELECT q.id AS question_id, a.id AS answer_id, a.body, a.language, e.vector, COALESCE(s.score, 0) AS score
    FROM question_embeddings e
    JOIN questions q ON q.id = e.question_id
    JOIN answers a ON a.id = q.accepted_answer_id
    LEFT JOIN cache_scores s ON s.source_answer_id = a.id
    WHERE q.id != @id AND a.body IS NOT NULL AND TRIM(a.body) != ''
      -- 機器人的回答不當來源，否則前綴會疊加，分數也會分散。
      AND a.cached_from_answer_id IS NULL
      AND COALESCE(s.score, 0) > @block
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
    for (const row of candidates.iterate({ id: questionId, block: config.cacheBlockScore })) {
      const similarity = dot(vector, fromBlob(row.vector));
      const adjustment = Math.max(-config.cacheMaxPenalty, Math.min(config.cacheMaxBoost, row.score * config.cacheScoreStep));
      const adjusted = similarity + adjustment;
      if (!best || adjusted > best.adjusted) best = { ...row, similarity, adjusted };
    }
    return best && best.adjusted >= config.semanticCacheThreshold ? best : null;
  };

  const setFeedbackColumn = db.prepare('UPDATE answers SET cache_feedback = ? WHERE id = ?');
  const upsertScore = db.prepare(`
    INSERT INTO cache_scores (source_answer_id, source_question_id, score, positive_count, negative_count, updated_at)
    VALUES (@answer, @question, @score, @positive, @negative, @now)
    ON CONFLICT (source_answer_id) DO UPDATE SET
      score = score + excluded.score,
      positive_count = positive_count + excluded.positive_count,
      negative_count = negative_count + excluded.negative_count,
      updated_at = excluded.updated_at
  `);
  const cachedAnswersOf = db.prepare('SELECT * FROM answers WHERE question_id = ? AND cached_from_answer_id IS NOT NULL');
  const humanAnswerCount = db.prepare(`
    SELECT COUNT(*) AS n FROM answers WHERE question_id = @question AND author_id != @author AND cached_from_answer_id IS NULL
  `);

  // 一則快取回答只算一次；回饋改變時先扣回舊的，再算新的。
  const setFeedback = db.transaction((answer, next) => {
    const previous = answer.cache_feedback;
    if (previous === next) return;
    const value = (feedback) => (feedback === 'positive' ? 1 : feedback === 'negative' ? -1 : 0);
    upsertScore.run({
      answer: answer.cached_from_answer_id,
      question: answer.cached_from_question_id,
      score: value(next) - value(previous),
      positive: (next === 'positive' ? 1 : 0) - (previous === 'positive' ? 1 : 0),
      negative: (next === 'negative' ? 1 : 0) - (previous === 'negative' ? 1 : 0),
      now: nowIso(),
    });
    setFeedbackColumn.run(next, answer.id);
  });

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
    for (let rows = missingVectors.all(); rows.length; rows = missingVectors.all()) {
      for (const row of rows) saveVector.run(row.id, toBlob(await embedder.embed(questionText(row))));
    }
  }
  const timer = embedder ? setInterval(() => track(backfill()), config.embeddingBackfillMs) : null;
  timer?.unref();
  if (embedder) setImmediate(() => track(backfill()));

  return {
    enabled: Boolean(embedder),

    // 回覆後不久就標記已解決，而且沒有別人回答，才視為機器人解決的。
    questionResolved(question) {
      const human = humanAnswerCount.get({ question: question.id, author: question.author_id }).n;
      if (human > 0) return;
      for (const answer of cachedAnswersOf.all(question.id)) {
        const elapsed = Date.now() - Date.parse(answer.created_at);
        if (!answer.cache_feedback && elapsed <= config.cacheResolveWindowMs) setFeedback(answer, 'positive');
      }
    },

    // 採納機器人的回答是加分；有機器人回答卻採納別人的，表示舊解答不適用。
    answerAccepted(question, accepted) {
      if (accepted.cached_from_answer_id) {
        setFeedback(accepted, 'positive');
        return;
      }
      for (const answer of cachedAnswersOf.all(question.id)) setFeedback(answer, 'negative');
    },

    // 只有發問者的投票算數，避免別人灌票影響快取。
    answerVoted(question, answer, voterId, value) {
      if (!answer.cached_from_answer_id || voterId !== question.author_id) return;
      if (value === -1) setFeedback(answer, 'negative');
      else if (answer.cache_feedback === 'negative') setFeedback(answer, null);
    },

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
