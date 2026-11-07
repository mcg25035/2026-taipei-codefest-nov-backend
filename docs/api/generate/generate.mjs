// 從 openapi.yaml 和 header.md 產生 api-spec.md。在 backend/ 執行 npm run docs:api。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../backend/package.json'));
const { parse } = require('yaml');
const root = path.join(here, '../');
const spec = parse(fs.readFileSync(root + 'openapi.yaml', 'utf8'));
const S = spec.components.schemas;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>');
const refName = (r) => r.split('/').pop();
const deref = (o) => {
  if (!o?.$ref) return o;
  const parts = o.$ref.slice(2).split('/');
  return deref(parts.reduce((a, k) => a[k], spec));
};
function typeOf(s) {
  if (!s) return '';
  if (s.$ref) return `[${refName(s.$ref)}](#${refName(s.$ref).toLowerCase()})`;
  if (s.allOf?.length === 1) return typeOf(s.allOf[0]);
  if (s.oneOf) return s.oneOf.map(typeOf).join(' \\| ');
  if (s.const !== undefined) return `\`${s.const}\``;
  if (s.enum) return s.enum.map((v) => `\`${v}\``).join(' \\| ');
  if (Array.isArray(s.type)) return s.type.map((t) => (t === 'null' ? 'null' : typeOf({ ...s, type: t }))).join(' \\| ');
  if (s.type === 'array') return `${typeOf(s.items)}[]`;
  if (s.format === 'date-time') return 'string（時間）';
  if (s.format === 'uri') return 'string（URL）';
  if (s.format === 'binary') return '檔案';
  return s.type ?? 'object';
}
function limits(s) {
  const out = [];
  if (s.minimum !== undefined) out.push(`最小 ${s.minimum}`);
  if (s.exclusiveMinimum !== undefined) out.push(`大於 ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined) out.push(`最大 ${s.maximum}`);
  if (s.minLength !== undefined) out.push(`最短 ${s.minLength}`);
  if (s.maxLength !== undefined) out.push(`最長 ${s.maxLength} 字`);
  if (s.maxItems !== undefined) out.push(`最多 ${s.maxItems} 項`);
  if (s.minProperties) out.push(`至少 ${s.minProperties} 個欄位`);
  if (s.default !== undefined) out.push(`預設 \`${s.default}\``);
  return out.join('，');
}
const describe = (s) => [s.description, limits(s)].filter(Boolean).join('。');
function flatten(schema, prefix = '') {
  const s = deref(schema);
  const rows = [];
  const required = new Set(s.required ?? []);
  for (const part of s.allOf ?? []) rows.push(...flatten(part, prefix));
  for (const [name, prop] of Object.entries(s.properties ?? {})) {
    const inner = prop.$ref ? null : prop;
    rows.push({ name: prefix + name, type: typeOf(prop), required: required.has(name), desc: describe(prop.$ref ? {} : prop) });
    if (inner?.type === 'object' && inner.properties) rows.push(...flatten(inner, `${prefix}${name}.`));
    if (inner?.type === 'array' && inner.items?.type === 'object' && inner.items.properties) rows.push(...flatten(inner.items, `${prefix}${name}[].`));
  }
  return rows;
}
const table = (rows) => ['| 欄位 | 型別 | 必填 | 說明 |', '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.name}\` | ${r.type} | ${r.required ? '是' : ''} | ${cell(r.desc)} |`)].join('\n');
const TAG_TITLES = { Session: '登入', Me: '個人資料', Push: '推播', Media: '媒體', Question: '問題', Answer: '回答與投票', Assist: '現場協助', PII: '個資標記', Reward: '獎勵', Notification: '通知', Realtime: 'SSE', Meta: '系統' };
const out = [];
const summary = ['| 方法 | 路徑 | 用途 | 需要 token |', '|---|---|---|---|'];
const sections = {};
let count = 0;
for (const [p, item] of Object.entries(spec.paths)) {
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = item[m];
    if (!op) continue;
    count++;
    const auth = !(op.security && op.security.length === 0);
    summary.push(`| ${m.toUpperCase()} | \`${p}\` | ${op.summary} | ${auth ? '是' : '否'} |`);
    const L = [`### ${m.toUpperCase()} ${p}`, '', `${op.summary}。${auth ? '' : '不需要 token。'}`, ''];
    if (op.description) L.push(op.description.trim(), '');
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref);
    if (params.length) {
      L.push('**參數**', '', '| 名稱 | 位置 | 型別 | 必填 | 說明 |', '|---|---|---|---|---|');
      for (const q of params) L.push(`| \`${q.name}\` | ${q.in === 'path' ? '路徑' : 'query'} | ${typeOf(q.schema)} | ${q.required ? '是' : ''} | ${cell([q.description, limits(q.schema ?? {})].filter(Boolean).join('。'))} |`);
      L.push('');
    }
    const body = op.requestBody?.content;
    if (body) {
      const [ct, media] = Object.entries(body)[0];
      L.push(`**請求內容**（\`${ct}\`${op.requestBody.required ? '' : '，選填'}）`, '');
      const rows = flatten(media.schema);
      L.push(rows.length ? table(rows) : typeOf(media.schema), '');
    }
    L.push('**回應**', '');
    const errors = [];
    for (const [code, r0] of Object.entries(op.responses)) {
      const r = deref(r0);
      if (Number(code) >= 400) { errors.push(code); continue; }
      const content = r.content?.['application/json'];
      if (!content) { L.push(`- \`${code}\`：${r.description}${r.content ? '（`text/event-stream`）' : '，沒有內容'}`); continue; }
      const sch = deref(content.schema);
      const others = Object.entries(sch.properties ?? {}).filter(([k]) => k !== 'data');
      const data = sch.properties?.data;
      let shape = data ? `\`data\` 是 ${typeOf(data)}` : '';
      if (!data) shape = Object.keys(sch.properties ?? {}).map((k) => `\`${k}\``).join('、');
      if (others.length && data) shape += `，另有 ${others.map(([k, v]) => `\`${k}\`（${typeOf(v)}）`).join('、')}`;
      L.push(`- \`${code}\`：${r.description}；${shape}`);
      if (data && !data.$ref && (data.type === 'object' || data.type === 'array')) {
        const inner = data.type === 'array' ? data.items : data;
        const rows = flatten(inner);
        if (rows.length) L.push('', table(rows), '');
      }
    }
    if (errors.length) L.push(`- 錯誤：${errors.map((c) => `\`${c}\``).join('、')}`);
    L.push('');
    (sections[op.tags[0]] ??= []).push(L.join('\n'));
  }
}
const SKIP = new Set(['ErrorResponse']);
const schemas = Object.entries(S).filter(([n]) => !SKIP.has(n)).map(([n, s]) => {
  const L = [`### ${n}`, ''];
  if (s.description) L.push(s.description.trim(), '');
  const rows = flatten(s);
  if (rows.length) L.push(table(rows));
  else L.push(`型別：${typeOf(s)}${limits(s) ? `（${limits(s)}）` : ''}`);
  L.push('');
  return L.join('\n');
});
const head = fs.readFileSync(path.join(here, 'header.md'), 'utf8').replace('{{COUNT}}', count).replace('{{SUMMARY}}', summary.join('\n'));
const endpoints = Object.keys(TAG_TITLES).filter((t) => sections[t]).map((t) => `## ${TAG_TITLES[t]}\n\n${sections[t].join('\n')}`).join('\n');
fs.writeFileSync(root + 'api-spec.md', `${head}\n${endpoints}\n## 資料結構\n\n${schemas.join('\n')}`);
console.log('endpoints', count, 'schemas', schemas.length);
