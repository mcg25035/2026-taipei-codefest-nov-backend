import crypto from 'node:crypto';

export function createSignatures({ db, config }) {
  let row = db.prepare("SELECT value FROM settings WHERE key = 'media_signing_secret'").get();
  if (!row) {
    row = { value: crypto.randomBytes(32).toString('hex') };
    db.prepare("INSERT INTO settings (key, value) VALUES ('media_signing_secret', ?)").run(row.value);
  }
  const sign = (id, exp) => crypto.createHmac('sha256', row.value).update(`${id}.${exp}`).digest('base64url');
  return {
    query(id) {
      const exp = Date.now() + config.mediaPreviewTtlMs;
      return `exp=${exp}&sig=${sign(id, exp)}`;
    },
    verify(id, exp, sig) {
      if (typeof exp !== 'string' || typeof sig !== 'string' || !(Number(exp) > Date.now())) return false;
      const expected = Buffer.from(sign(id, exp));
      const actual = Buffer.from(sig);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    },
  };
}
