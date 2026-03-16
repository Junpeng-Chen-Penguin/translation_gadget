'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const CSV_FILE = path.join(ROOT, 'data', 'standard-lexicon.csv');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') { field += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { row.push(field); field = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); field = '';
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

function headerIndex(headers, candidates) {
  const normalized = headers.map((h) => String(h).trim().toLowerCase());
  for (const key of candidates) {
    const idx = normalized.indexOf(key);
    if (idx >= 0) return idx;
  }
  return -1;
}

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

function loadDbConfig() {
  const envHost = String(process.env.DB_HOST || '').trim();
  if (envHost) {
    return {
      host: envHost,
      port: Number(process.env.DB_PORT || 3306),
      user: String(process.env.DB_USER || 'root'),
      password: String(process.env.DB_PASSWORD || ''),
      database: String(process.env.DB_DATABASE || 'standard_lexicon')
    };
  }

  const file = path.join(ROOT, 'ai-config.local.js');
  if (!fs.existsSync(file)) {
    throw new Error('缺少数据库配置：请设置环境变量 DB_HOST，或在 ai-config.local.js 中配置 window.DB_CONFIG');
  }
  const source = fs.readFileSync(file, 'utf-8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 1000 });
  const cfg = sandbox.window && sandbox.window.DB_CONFIG ? sandbox.window.DB_CONFIG : null;
  if (!cfg || !cfg.host) {
    throw new Error('ai-config.local.js 未配置 DB_CONFIG 或缺少 host 字段');
  }
  return {
    host: String(cfg.host),
    port: Number(cfg.port || 3306),
    user: String(cfg.user || 'root'),
    password: String(cfg.password || ''),
    database: String(cfg.database || 'standard_lexicon')
  };
}

async function main() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`CSV 文件不存在：${CSV_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_FILE, 'utf-8');
  const matrix = parseCsv(content);
  if (!matrix.length) {
    console.log('CSV 文件为空，跳过迁移。');
    return;
  }

  const headers = matrix[0];
  const dataRows = matrix.slice(1);
  const sourceIdx = headerIndex(headers, ['source_text', 'source', '词条', '中文词条', 'text']);
  const translationIdx = headerIndex(headers, ['translation_en', 'translation', '英文翻译', '英文']);
  const typeIdx = headerIndex(headers, ['lexicon_type', 'type', '来源类型', '词条类型']);

  if (sourceIdx < 0 || translationIdx < 0) {
    console.error('CSV 缺少必要列（source_text / translation_en）');
    process.exit(1);
  }

  const normalized = dedupeBySourceText(
    dataRows.map((cols) => ({
      source_text: String(cols[sourceIdx] || '').trim(),
      translation_en: String(cols[translationIdx] || '').trim(),
      lexicon_type: String(typeIdx >= 0 ? cols[typeIdx] : '').trim() || '引入词条'
    })).filter((r) => r.source_text)
  );

  console.log(`解析到 ${normalized.length} 条词条，开始写入 MySQL…`);

  const dbCfg = loadDbConfig();
  const conn = await mysql.createConnection(dbCfg);

  try {
    for (const row of normalized) {
      await conn.execute(
        `INSERT INTO lexicon (source_text, translation_en, lexicon_type)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           translation_en = VALUES(translation_en),
           lexicon_type   = VALUES(lexicon_type)`,
        [row.source_text, row.translation_en, row.lexicon_type]
      );
    }
    console.log(`迁移完成，共写入 ${normalized.length} 条词条。`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('迁移失败：', err.message);
  process.exit(1);
});
