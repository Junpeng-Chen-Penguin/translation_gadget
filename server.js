const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { URL } = require('url');

const HOST = String(process.env.HOST || '0.0.0.0');
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const DEFAULT_LEXICON_FILE = path.join(ROOT, 'data', 'standard-lexicon.csv');
const LEXICON_FILE = IS_VERCEL
  ? path.join('/tmp', 'standard-lexicon.csv')
  : DEFAULT_LEXICON_FILE;
const PROMPT_TEMPLATE_FILE = path.join(ROOT, 'prompts', 'ai-translate.prompt.md');
const IDENTIFY_PROMPT_TEMPLATE_FILE = path.join(ROOT, 'prompts', 'ai-identify.prompt.md');
const PROOFREAD_PROMPT_TEMPLATE_FILE = path.join(ROOT, 'prompts', 'ai-proofread.prompt.md');
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
const UPSTREAM_RETRY_TIMES = Number(process.env.UPSTREAM_RETRY_TIMES || 1);
const UPSTREAM_RETRY_DELAY_MS = Number(process.env.UPSTREAM_RETRY_DELAY_MS || 800);
const MAX_TRANSLATE_ROWS = Number(process.env.MAX_TRANSLATE_ROWS || 80);
const MAX_TOTAL_INPUT_CHARS = Number(process.env.MAX_TOTAL_INPUT_CHARS || 120000);
const MAX_IDENTIFY_ROWS = Number(process.env.MAX_IDENTIFY_ROWS || 300);
const MAX_IDENTIFY_INPUT_CHARS = Number(process.env.MAX_IDENTIFY_INPUT_CHARS || 200000);
const MAX_PROOFREAD_ROWS = Number(process.env.MAX_PROOFREAD_ROWS || 120);
const MAX_PROOFREAD_INPUT_CHARS = Number(process.env.MAX_PROOFREAD_INPUT_CHARS || 180000);

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

// 函数：sendJson。
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

// 轻量 CSV 解析器：用于词库读写相关流程。
// 函数：parseCsv。
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      field += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => String(v).trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  return rows;
}

// 函数：toCsvField。
function toCsvField(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// 函数：headerIndex。
function headerIndex(headers, candidates) {
  const normalized = headers.map((h) => String(h).trim().toLowerCase());
  for (const key of candidates) {
    const idx = normalized.indexOf(key);
    if (idx >= 0) return idx;
  }
  return -1;
}

// 函数：dedupeBySourceText。
function dedupeBySourceText(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const sourceText = String(row?.source_text || '').trim();
    if (!sourceText) return;
    map.set(sourceText, {
      source_text: sourceText,
      translation_en: String(row?.translation_en || '').trim(),
      lexicon_type: String(row?.lexicon_type || '').trim() || '引入词条'
    });
  });
  return Array.from(map.values());
}

// 函数：ensureLexiconFile。
async function ensureLexiconFile() {
  await fs.promises.mkdir(path.dirname(LEXICON_FILE), { recursive: true });
  if (!fs.existsSync(LEXICON_FILE)) {
    if (fs.existsSync(DEFAULT_LEXICON_FILE)) {
      const seed = await fs.promises.readFile(DEFAULT_LEXICON_FILE, 'utf-8');
      await fs.promises.writeFile(LEXICON_FILE, String(seed || 'source_text,translation_en,lexicon_type\n'), 'utf-8');
      return;
    }
    await fs.promises.writeFile(LEXICON_FILE, 'source_text,translation_en,lexicon_type\n', 'utf-8');
  }
}

// 从 CSV 读取并归一化标准词库数据。
// 函数：readLexiconRows。
async function readLexiconRows() {
  await ensureLexiconFile();
  const content = await fs.promises.readFile(LEXICON_FILE, 'utf-8');
  const matrix = parseCsv(String(content || ''));
  if (!matrix.length) return [];
  const headers = matrix[0];
  const rows = matrix.slice(1);
  const sourceIdx = headerIndex(headers, ['source_text', 'source', '词条', '中文词条', 'text']);
  const translationIdx = headerIndex(headers, ['translation_en', 'translation', '英文翻译', '英文']);
  const typeIdx = headerIndex(headers, ['lexicon_type', 'type', '来源类型', '词条类型']);
  if (sourceIdx < 0 || translationIdx < 0) return [];
  const normalized = rows.map((cols) => ({
    source_text: String(cols[sourceIdx] || '').trim(),
    translation_en: String(cols[translationIdx] || '').trim(),
    lexicon_type: String(typeIdx >= 0 ? cols[typeIdx] : '').trim() || '引入词条'
  }));
  return dedupeBySourceText(normalized);
}

// 原子化写入词库数据（先写临时文件再重命名）。
// 函数：writeLexiconRows。
async function writeLexiconRows(rows) {
  await ensureLexiconFile();
  const normalized = dedupeBySourceText(rows);
  const lines = ['source_text,translation_en,lexicon_type'];
  normalized.forEach((row) => {
    lines.push([row.source_text, row.translation_en, row.lexicon_type || '引入词条'].map(toCsvField).join(','));
  });
  const content = `${lines.join('\n')}\n`;
  const tmpFile = `${LEXICON_FILE}.tmp`;
  await fs.promises.writeFile(tmpFile, content, 'utf-8');
  await fs.promises.rename(tmpFile, LEXICON_FILE);
  return normalized;
}

// 函数：readBody。
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// 从 ai-config.local.js 读取本地代理配置。
// 函数：loadConfig。
function loadConfig() {
  const envApiKey = String(process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const envBaseUrl = String(process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || '').trim();
  const envEndpoint = String(process.env.AI_ENDPOINT || '').trim();
  const envModel = String(process.env.AI_MODEL || '').trim();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      baseUrl: (envBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
      endpoint: envEndpoint || '/azure/responses',
      model: envModel || 'gpt-5.1-mini'
    };
  }

  const file = path.join(ROOT, 'ai-config.local.js');
  if (!fs.existsSync(file)) {
    throw new Error('缺少 AI 配置：请设置环境变量 AI_API_KEY，或提供 ai-config.local.js');
  }
  const source = fs.readFileSync(file, 'utf-8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 1000 });
  const cfg = sandbox.window && sandbox.window.AI_CONFIG ? sandbox.window.AI_CONFIG : {};
  if (!cfg.apiKey) {
    throw new Error('ai-config.local.js 未配置 apiKey');
  }
  return {
    apiKey: String(cfg.apiKey),
    baseUrl: String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
    endpoint: String(cfg.endpoint || '/azure/responses'),
    model: String(cfg.model || 'gpt-5.1-mini')
  };
}

// 函数：requestJson。
function requestJson(urlString, options, bodyObject) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(bodyObject);
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...options.headers
      },
      timeout: UPSTREAM_TIMEOUT_MS
    }, (resp) => {
      let raw = '';
      resp.on('data', (chunk) => { raw += chunk; });
      resp.on('end', () => {
        resolve({
          ok: resp.statusCode >= 200 && resp.statusCode < 300,
          status: resp.statusCode,
          text: raw
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 函数：isRetryableNetworkError。
function isRetryableNetworkError(err) {
  const msg = String(err?.message || '');
  return /上游请求超时|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN|ECONNREFUSED|ENOTFOUND/i.test(msg);
}

// 函数：sleep。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 函数：requestJsonWithRetry。
async function requestJsonWithRetry(urlString, options, bodyObject) {
  let lastError = null;
  // 仅在网络抖动或超时时进行重试。
  for (let attempt = 0; attempt <= UPSTREAM_RETRY_TIMES; attempt++) {
    try {
      return await requestJson(urlString, options, bodyObject);
    } catch (err) {
      lastError = err;
      const canRetry = isRetryableNetworkError(err) && attempt < UPSTREAM_RETRY_TIMES;
      if (!canRetry) break;
      await sleep(UPSTREAM_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError || new Error('上游请求失败');
}

// 函数：loadPromptTemplate。
function loadPromptTemplate() {
  if (!fs.existsSync(PROMPT_TEMPLATE_FILE)) {
    throw new Error(`缺少 Prompt 模板文件：${PROMPT_TEMPLATE_FILE}`);
  }
  return fs.readFileSync(PROMPT_TEMPLATE_FILE, 'utf-8');
}

// 函数：loadIdentifyPromptTemplate。
function loadIdentifyPromptTemplate() {
  if (!fs.existsSync(IDENTIFY_PROMPT_TEMPLATE_FILE)) {
    throw new Error(`缺少 Prompt 模板文件：${IDENTIFY_PROMPT_TEMPLATE_FILE}`);
  }
  return fs.readFileSync(IDENTIFY_PROMPT_TEMPLATE_FILE, 'utf-8');
}

// 函数：loadProofreadPromptTemplate。
function loadProofreadPromptTemplate() {
  if (!fs.existsSync(PROOFREAD_PROMPT_TEMPLATE_FILE)) {
    throw new Error(`缺少 Prompt 模板文件：${PROOFREAD_PROMPT_TEMPLATE_FILE}`);
  }
  return fs.readFileSync(PROOFREAD_PROMPT_TEMPLATE_FILE, 'utf-8');
}

// 函数：renderPromptTemplate。
function renderPromptTemplate(template, variables) {
  return Object.keys(variables).reduce((text, key) => {
    const value = String(variables[key] ?? '');
    return text.replaceAll(`{{${key}}}`, value);
  }, template);
}

// 函数：buildPrompt。
function buildPrompt(rows, lexiconRows) {
  const normalizedLexicon = Array.isArray(lexiconRows)
    ? lexiconRows
      .map((item) => ({
        source_text: String(item?.source_text || item?.source || '').trim(),
        translation_en: String(item?.translation_en || item?.translation || '').trim()
      }))
      .filter((item) => item.source_text && item.translation_en)
    : [];
  const lexiconSection = normalizedLexicon.length
    ? [
      '标准词库（必须优先遵循，含近义词/变体复用规则）：',
      JSON.stringify(normalizedLexicon),
      '',
      '术语一致性规则：',
      'A) 若待翻译词条与标准词库词条语义等价（例如“确认/确定”“登录/登陆”），请复用同一英文译法；',
      'B) 若待翻译内容是句子且包含标准词库词条片段（如“xxx公司”），该片段的英文必须与标准词库一致；',
      'C) 仅在语义明显不同且无法等价映射时，才可不用标准词库译法。'
    ].join('\n')
    : '标准词库为空：按通用产品本地化最佳实践翻译。';

  const template = loadPromptTemplate();
  // 将词库约束与当前词条注入同一 Prompt 模板。
  return renderPromptTemplate(template, {
    LEXICON_SECTION: lexiconSection,
    INPUT_ROWS_JSON: JSON.stringify(rows)
  });
}

// 函数：buildIdentifyPrompt。
function buildIdentifyPrompt(rows, lexiconRows) {
  const normalizedLexicon = Array.isArray(lexiconRows)
    ? lexiconRows
      .map((item) => ({
        source_text: String(item?.source_text || item?.source || '').trim(),
        translation_en: String(item?.translation_en || item?.translation || '').trim()
      }))
      .filter((item) => item.source_text && item.translation_en)
    : [];

  const template = loadIdentifyPromptTemplate();
  return renderPromptTemplate(template, {
    EXISTING_LEXICON_JSON: JSON.stringify(normalizedLexicon),
    INPUT_ROWS_JSON: JSON.stringify(rows)
  });
}

// 函数：buildProofreadPrompt。
function buildProofreadPrompt(rows, lexiconRows) {
  const normalizedLexicon = Array.isArray(lexiconRows)
    ? lexiconRows
      .map((item) => ({
        source_text: String(item?.source_text || item?.source || '').trim(),
        translation_en: String(item?.translation_en || item?.translation || '').trim()
      }))
      .filter((item) => item.source_text && item.translation_en)
    : [];

  const template = loadProofreadPromptTemplate();
  return renderPromptTemplate(template, {
    EXISTING_LEXICON_JSON: JSON.stringify(normalizedLexicon),
    INPUT_ROWS_JSON: JSON.stringify(rows)
  });
}

// 函数：buildResponsesPayload。
function buildResponsesPayload(model, prompt) {
  return {
    model,
    input: [
      { role: 'system', content: 'You are a precise localization assistant.' },
      { role: 'user', content: prompt }
    ]
  };
}

// 函数：extractContent。
function extractContent(parsed) {
  if (typeof parsed?.output_text === 'string' && parsed.output_text.trim()) {
    return parsed.output_text;
  }

  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string' && c.text.trim()) return c.text;
    }
  }
  return '';
}

// 函数：tryParseJsonArray。
function tryParseJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(String(fenced[1]).trim());

  for (const item of candidates) {
    try {
      const parsed = JSON.parse(item);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

// 翻译接口：校验入参、组装 Prompt、调用上游 responses 接口。
// 函数：handleTranslate。
async function handleTranslate(req, res) {
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lexiconRows = Array.isArray(body.lexicon_rows) ? body.lexicon_rows : [];
    if (!rows.length) {
      return sendJson(res, 400, { error: 'rows 不能为空' });
    }
    if (rows.length > MAX_TRANSLATE_ROWS) {
      return sendJson(res, 400, {
        error: 'too_many_rows',
        message: `单次最多支持 ${MAX_TRANSLATE_ROWS} 条，请分批请求`
      });
    }
    const totalChars = rows.reduce((sum, row) => {
      const key = String(row?.key || '');
      const sourceText = String(row?.source_text || row?.source || '');
      const contextInfo = String(row?.context_info || row?.context || '');
      return sum + key.length + sourceText.length + contextInfo.length;
    }, 0);
    if (totalChars > MAX_TOTAL_INPUT_CHARS) {
      return sendJson(res, 400, {
        error: 'input_too_large',
        message: `单次输入字符总量超限（>${MAX_TOTAL_INPUT_CHARS}），请分批请求`
      });
    }

    const cfg = loadConfig();
    if (!/(^|\/)responses($|\/|\?)/i.test(cfg.endpoint)) {
      return sendJson(res, 400, {
        error: 'invalid_config',
        message: '当前仅支持 responses 接口，请将 endpoint 配置为 /azure/responses'
      });
    }
    const upstreamUrl = `${cfg.baseUrl}${cfg.endpoint}`;
    const prompt = buildPrompt(rows, lexiconRows);
    const payload = buildResponsesPayload(cfg.model, prompt);
    const upstreamResp = await requestJsonWithRetry(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`
      }
    }, payload);

    if (!upstreamResp.ok) {
      return sendJson(res, upstreamResp.status || 500, {
        error: 'upstream_error',
        message: upstreamResp.text
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(upstreamResp.text);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'upstream_non_json',
        message: upstreamResp.text.slice(0, 500)
      });
    }

    const content = extractContent(parsed);
    if (!content) {
      return sendJson(res, 502, {
        error: 'upstream_empty_content',
        message: upstreamResp.text.slice(0, 500)
      });
    }
    return sendJson(res, 200, { content });
  } catch (err) {
    return sendJson(res, 500, { error: 'proxy_error', message: String(err.message || err) });
  }
}

// AI 鉴别接口：从候选词条中识别可作为系统词条的条目，并返回建议译文。
// 函数：handleIdentify。
async function handleIdentify(req, res) {
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lexiconRows = Array.isArray(body.lexicon_rows) ? body.lexicon_rows : [];
    if (!rows.length) {
      return sendJson(res, 400, { error: 'rows 不能为空' });
    }
    if (rows.length > MAX_IDENTIFY_ROWS) {
      return sendJson(res, 400, {
        error: 'too_many_rows',
        message: `单次最多支持 ${MAX_IDENTIFY_ROWS} 条，请分批请求`
      });
    }
    const totalChars = rows.reduce((sum, row) => {
      const key = String(row?.key || '');
      const sourceText = String(row?.source_text || row?.source || '');
      const contextInfo = String(row?.context_info || row?.context || '');
      return sum + key.length + sourceText.length + contextInfo.length;
    }, 0);
    if (totalChars > MAX_IDENTIFY_INPUT_CHARS) {
      return sendJson(res, 400, {
        error: 'input_too_large',
        message: `单次输入字符总量超限（>${MAX_IDENTIFY_INPUT_CHARS}），请分批请求`
      });
    }

    const cfg = loadConfig();
    if (!/(^|\/)responses($|\/|\?)/i.test(cfg.endpoint)) {
      return sendJson(res, 400, {
        error: 'invalid_config',
        message: '当前仅支持 responses 接口，请将 endpoint 配置为 /azure/responses'
      });
    }
    const upstreamUrl = `${cfg.baseUrl}${cfg.endpoint}`;
    const prompt = buildIdentifyPrompt(rows, lexiconRows);
    const payload = buildResponsesPayload(cfg.model, prompt);
    const upstreamResp = await requestJsonWithRetry(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`
      }
    }, payload);

    if (!upstreamResp.ok) {
      return sendJson(res, upstreamResp.status || 500, {
        error: 'upstream_error',
        message: upstreamResp.text
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(upstreamResp.text);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'upstream_non_json',
        message: upstreamResp.text.slice(0, 500)
      });
    }

    const content = extractContent(parsed);
    if (!content) {
      return sendJson(res, 502, {
        error: 'upstream_empty_content',
        message: upstreamResp.text.slice(0, 500)
      });
    }

    const arr = tryParseJsonArray(content);
    if (!arr) {
      return sendJson(res, 502, {
        error: 'upstream_invalid_format',
        message: content.slice(0, 500)
      });
    }

    const confidenceMap = new Map();
    arr.forEach((item) => {
      const sourceText = String(item?.source_text || item?.source || item?.term || '').trim();
      if (!sourceText) return;
      const rawConfidence = String(item?.confidence || '').trim();
      const confidence = rawConfidence === '高' || rawConfidence === '中' || rawConfidence === '低'
        ? rawConfidence
        : '中';
      confidenceMap.set(sourceText, confidence);
    });

    const normalized = dedupeBySourceText(
      arr.map((item) => ({
        source_text: String(item?.source_text || item?.source || item?.term || '').trim(),
        translation_en: String(item?.translation_en || item?.translation || item?.en || '').trim(),
        lexicon_type: 'AI鉴别'
      }))
        .filter((item) => item.source_text && item.translation_en)
    ).map((row) => ({
      source_text: row.source_text,
      translation_en: row.translation_en,
      confidence: confidenceMap.get(row.source_text) || '中'
    }));

    return sendJson(res, 200, { rows: normalized, count: normalized.length });
  } catch (err) {
    return sendJson(res, 500, { error: 'identify_error', message: String(err.message || err) });
  }
}

// AI 校对接口：对已翻译结果做术语一致性与句式一致性修正。
// 函数：handleProofread。
async function handleProofread(req, res) {
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const lexiconRows = Array.isArray(body.lexicon_rows) ? body.lexicon_rows : [];
    if (!rows.length) {
      return sendJson(res, 400, { error: 'rows 不能为空' });
    }
    if (rows.length > MAX_PROOFREAD_ROWS) {
      return sendJson(res, 400, {
        error: 'too_many_rows',
        message: `单次最多支持 ${MAX_PROOFREAD_ROWS} 条，请分批请求`
      });
    }
    const totalChars = rows.reduce((sum, row) => {
      const key = String(row?.key || '');
      const sourceText = String(row?.source_text || row?.source || '');
      const contextInfo = String(row?.context_info || row?.context || '');
      const draftTranslation = String(row?.draft_translation || row?.translation || '');
      return sum + key.length + sourceText.length + contextInfo.length + draftTranslation.length;
    }, 0);
    if (totalChars > MAX_PROOFREAD_INPUT_CHARS) {
      return sendJson(res, 400, {
        error: 'input_too_large',
        message: `单次输入字符总量超限（>${MAX_PROOFREAD_INPUT_CHARS}），请分批请求`
      });
    }

    const cfg = loadConfig();
    if (!/(^|\/)responses($|\/|\?)/i.test(cfg.endpoint)) {
      return sendJson(res, 400, {
        error: 'invalid_config',
        message: '当前仅支持 responses 接口，请将 endpoint 配置为 /azure/responses'
      });
    }
    const upstreamUrl = `${cfg.baseUrl}${cfg.endpoint}`;
    const prompt = buildProofreadPrompt(rows, lexiconRows);
    const payload = buildResponsesPayload(cfg.model, prompt);
    const upstreamResp = await requestJsonWithRetry(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`
      }
    }, payload);

    if (!upstreamResp.ok) {
      return sendJson(res, upstreamResp.status || 500, {
        error: 'upstream_error',
        message: upstreamResp.text
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(upstreamResp.text);
    } catch (e) {
      return sendJson(res, 502, {
        error: 'upstream_non_json',
        message: upstreamResp.text.slice(0, 500)
      });
    }

    const content = extractContent(parsed);
    if (!content) {
      return sendJson(res, 502, {
        error: 'upstream_empty_content',
        message: upstreamResp.text.slice(0, 500)
      });
    }
    return sendJson(res, 200, { content });
  } catch (err) {
    return sendJson(res, 500, { error: 'proofread_error', message: String(err.message || err) });
  }
}

// 本地探活：仅表示服务进程可用，不依赖上游 AI。
// 函数：handleHealth。
async function handleHealth(_req, res) {
  return sendJson(res, 200, { ok: true });
}

// 上游探活：校验 AI 配置和接口可用性。
// 函数：handleUpstreamHealth。
async function handleUpstreamHealth(_req, res) {
  try {
    const cfg = loadConfig();
    if (!/(^|\/)responses($|\/|\?)/i.test(cfg.endpoint)) {
      return sendJson(res, 400, {
        ok: false,
        message: '当前仅支持 responses 接口，请将 endpoint 配置为 /azure/responses'
      });
    }
    const upstreamUrl = `${cfg.baseUrl}${cfg.endpoint}`;
    const payload = buildResponsesPayload(cfg.model, '请返回 JSON: {"ok": true}');
    const upstreamResp = await requestJsonWithRetry(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`
      }
    }, payload);

    if (!upstreamResp.ok) {
      return sendJson(res, upstreamResp.status || 500, {
        ok: false,
        message: upstreamResp.text.slice(0, 500)
      });
    }
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 500, { ok: false, message: String(err.message || err) });
  }
}

// 函数：handleGetLexicon。
async function handleGetLexicon(_req, res) {
  try {
    const rows = await readLexiconRows();
    return sendJson(res, 200, { rows });
  } catch (err) {
    return sendJson(res, 500, { error: 'lexicon_read_error', message: String(err.message || err) });
  }
}

// 词库写入接口：归一化请求体并持久化到 CSV。
// 函数：handleUpdateLexicon。
async function handleUpdateLexicon(req, res) {
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const normalized = rows.map((item) => ({
      source_text: String(item?.source_text || item?.source || '').trim(),
      translation_en: String(item?.translation_en || item?.translation || '').trim(),
      lexicon_type: String(item?.lexicon_type || item?.type || '').trim() || '引入词条'
    }));
    const savedRows = await writeLexiconRows(normalized);
    return sendJson(res, 200, { ok: true, count: savedRows.length });
  } catch (err) {
    return sendJson(res, 500, { error: 'lexicon_write_error', message: String(err.message || err) });
  }
}

// 函数：serveStatic。
function serveStatic(req, res) {
  let pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname === '/') pathname = '/index.html';
  const safePath = path.normalize(path.join(ROOT, pathname));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

async function requestHandler(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/api/translate' && req.method === 'POST') return handleTranslate(req, res);
  if (pathname === '/api/identify' && req.method === 'POST') return handleIdentify(req, res);
  if (pathname === '/api/proofread' && req.method === 'POST') return handleProofread(req, res);
  if (pathname === '/api/health' && req.method === 'GET') return handleHealth(req, res);
  if (pathname === '/api/health/upstream' && req.method === 'GET') return handleUpstreamHealth(req, res);
  if (pathname === '/api/lexicon' && req.method === 'GET') return handleGetLexicon(req, res);
  if (pathname === '/api/lexicon' && req.method === 'POST') return handleUpdateLexicon(req, res);

  return serveStatic(req, res);
}

module.exports = requestHandler;

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, HOST, () => {
    console.log(`Local server running: http://${HOST}:${PORT}`);
  });
}
