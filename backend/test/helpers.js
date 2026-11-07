import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createServer } from '../src/app.js';

const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/api/openapi.yaml');
const spec = parse(fs.readFileSync(specPath, 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(spec, 'openapi');

const pointer = (p) => p.replaceAll('~', '~0').replaceAll('/', '~1').replaceAll('{', '%7B').replaceAll('}', '%7D');

// 依 openapi.yaml 驗證回應，任何不符都會讓測試失敗。
export function assertMatchesSpec(method, specPathName, status, body) {
  const operation = spec.paths[specPathName]?.[method.toLowerCase()];
  if (!operation) throw new Error(`規格沒有 ${method} ${specPathName}`);
  const response = operation.responses[String(status)];
  if (!response) throw new Error(`規格沒有 ${method} ${specPathName} 的 ${status} 回應`);
  const base = `openapi#/paths/${pointer(specPathName)}/${method.toLowerCase()}/responses/${status}`;
  const ref = response.$ref ? `openapi${response.$ref}` : base;
  const resolved = response.$ref ? spec.components.responses[response.$ref.split('/').pop()] : response;
  if (!resolved.content) return;
  const validate = ajv.compile({ $ref: `${ref}/content/application~1json/schema` });
  if (!validate(body)) {
    throw new Error(`${method} ${specPathName} ${status} 不符合規格：${JSON.stringify(validate.errors, null, 2)}\n${JSON.stringify(body, null, 2)}`);
  }
}

export async function startTestServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codefest-test-'));
  const server = createServer({ dataDir, ...overrides });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

  async function call(method, specPathName, { token, body, params = {}, query, form } = {}) {
    const urlPath = specPathName.replace(/\{(\w+)\}/g, (_, k) => params[k]);
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetch(`${baseUrl}/api/v1${urlPath}${qs}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    assertMatchesSpec(method, specPathName, res.status, json);
    return { status: res.status, body: json, raw: text };
  }

  let counter = 0;
  const login = async (nickname = 'tester') => {
    const res = await call('POST', '/sessions', { body: { townpass_user_id: `tp-${++counter}`, nickname } });
    return { token: res.body.data.token, user: res.body.data.user };
  };

  let requestCounter = 0;
  const question = (overrides2 = {}) => ({
    body: '這份公文是什麼意思？',
    language: 'zh-TW',
    category: 'document_contract',
    assistance_mode: 'online',
    location_sharing: 'off',
    client_request_id: `req-${++requestCounter}`,
    ...overrides2,
  });

  return {
    server, baseUrl, call, login, question,
    async stop() {
      await server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const TAIPEI = { lat: 25.0339, lng: 121.5645 };
