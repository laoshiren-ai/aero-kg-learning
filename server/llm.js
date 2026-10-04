/**
 * ═══════════════════════════════════════════════════════════
 * 智谱开放平台调用封装（server.js / server/chat.js 共用）
 * ───────────────────────────────────────────────────────────
 * · API Key 读取优先级：环境变量 ZHIPU_API_KEY → server-config.json
 * · 模型降级：glm-4-flash 失败（网络 / 4xx / 5xx / 超时 / 结果不可接受）
 *   自动换 glm-4-air 重试一次
 * · Key 绝不下发前端、绝不写进代码
 * ═══════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODELS = ['glm-4-flash', 'glm-4-air'];
// 单次尝试的上游超时。22s 是实测 flash 正常返回（~350 token ≈ 15-22s）的必要预算；
// 调小会误杀正常但偏慢的返回，调大则卡住时用户等太久。
const TIMEOUT_MS = Number(process.env.AEROKG_LLM_TIMEOUT || 22000);

function loadApiKey() {
  if (process.env.ZHIPU_API_KEY && process.env.ZHIPU_API_KEY.trim()) {
    return process.env.ZHIPU_API_KEY.trim();
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-config.json'), 'utf8'));
    if (cfg && typeof cfg.zhipuApiKey === 'string' && cfg.zhipuApiKey.trim()) return cfg.zhipuApiKey.trim();
  } catch (e) { /* 未配置 */ }
  return '';
}
const configured = () => !!loadApiKey();

const NO_KEY_HINT = '服务器未配置 AI 密钥：请设置环境变量 ZHIPU_API_KEY，'
  + '或在项目根目录创建 server-config.json（{"zhipuApiKey":"..."}）';

/** 单次调用（不含降级） */
async function callModel(opts) {
  const apiKey = loadApiKey();
  if (!apiKey) return { ok: false, code: 'no_key', error: NO_KEY_HINT };

  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user || '' });

  try {
    const res = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        temperature: opts.temperature === undefined ? 0.6 : opts.temperature,
        max_tokens: opts.maxTokens || 800,
        messages: messages
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        code: (res.status === 401 || res.status === 403) ? 'auth' : 'upstream',
        status: res.status,
        error: `智谱 API 返回 ${res.status}` + (res.status === 401 ? '（API Key 无效或过期）' : ''),
        detail: String(detail).slice(0, 300)
      };
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content;
    if (!text) {
      return {
        ok: false, code: 'bad_shape', status: 502,
        error: '智谱返回结构异常（未找到 choices[0].message.content）',
        detail: JSON.stringify(data).slice(0, 300)
      };
    }
    return { ok: true, text: String(text), usage: (data && data.usage) || null };
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      code: isTimeout ? 'timeout' : 'network',
      error: isTimeout ? '请求智谱超时' : ('网络请求失败：' + ((err && err.message) || '未知错误'))
    };
  }
}

/**
 * 带降级的调用。
 * @param {object} opts
 *   system/user      提示词
 *   temperature/maxTokens/timeoutMs
 *   models           模型序列，默认 ['glm-4-flash','glm-4-air']
 *   accept(text)     结果验收函数；返回 false 视为失败 → 换下一个模型（用于"返回的不是合法 JSON"）
 * @returns {Promise<{ok:boolean, text?:string, model?:string, usage?:object, code?:string, error?:string, tried:Array}>}
 */
async function chat(opts) {
  const models = (opts.models && opts.models.length) ? opts.models : DEFAULT_MODELS;
  const tried = [];
  let lastFail = null;

  for (const model of models) {
    const r = await callModel(Object.assign({}, opts, { model: model }));
    if (!r.ok) {
      tried.push({ model: model, ok: false, code: r.code, status: r.status, error: r.error });
      lastFail = r;
      continue;                                   // 换下一个模型
    }
    if (typeof opts.accept === 'function' && !opts.accept(r.text)) {
      tried.push({ model: model, ok: false, code: 'rejected', error: '返回结果未通过验收（格式不合法）' });
      lastFail = { code: 'rejected', error: 'AI 返回内容格式不合法' };
      continue;                                   // 结果不可用 → 也换下一个模型
    }
    tried.push({ model: model, ok: true });
    return { ok: true, text: r.text, model: model, usage: r.usage, tried: tried };
  }

  return {
    ok: false,
    code: (lastFail && lastFail.code) || 'upstream',
    error: (lastFail && lastFail.error) || 'AI 服务不可用',
    detail: (lastFail && lastFail.detail) || '',
    tried: tried
  };
}

/** 常见 JSON 瑕疵修复（模型偶尔会写尾逗号 / 中文引号 / 单引号键） */
function repairJson(s) {
  return String(s)
    .replace(/[\u201c\u201d]/g, '"')          // 中文双引号 → 英文
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')            // 尾逗号
    .replace(/\n\s*\/\/[^\n]*/g, '')          // 行注释
    .replace(/'([^'\\]*)'(\s*:)/g, '"$1"$2'); // 单引号键
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹、前后废话、轻微语法瑕疵） */
function extractJson(text, kind) {
  if (!text) return null;
  const s0 = String(text).trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  const i = s0.indexOf(open), j = s0.lastIndexOf(close);
  if (i < 0 || j <= i) return null;
  const slice = s0.slice(i, j + 1);
  try { return JSON.parse(slice); } catch (e) { /* 走修复 */ }
  try { return JSON.parse(repairJson(slice)); } catch (e) { return null; }
}

module.exports = { ZHIPU_URL, DEFAULT_MODELS, TIMEOUT_MS, loadApiKey, configured, NO_KEY_HINT, callModel, chat, extractJson, repairJson };
