#!/usr/bin/env node
/**
 * 百度网盘 每日签到 + 每日答题 + 成长值查询
 *
 * 设计目标：给完全不懂技术的人用，跑在 GitHub Actions 上，零依赖、零成本、零服务器。
 *
 * 用法：
 *   node scripts/signin.js            # 签到 + 答题 + 查询
 *   node scripts/signin.js --check    # 只验证 Cookie 是否有效（排障用）
 *   node scripts/signin.js --no-answer
 *
 * Cookie 来源（优先级从高到低）：
 *   1. 环境变量 BAIDU_COOKIE（GitHub Secret 注入的就是这个）
 *   2. 环境变量 BAIDU_BDUSS（只填 BDUSS 值时用）
 *   3. 当前目录下的 .cookie 文件（仅本地调试用，已在 .gitignore 中）
 *
 * 输入要求（重要）：
 *   必须是**完整的一整行 Cookie**，且同时包含 BDUSS 和 STOKEN 两个字段。
 *   实测签到接口缺 STOKEN 会返回 400 Param error，只复制 BDUSS 的值一定失败。
 *   脚本会把各种粘贴格式（带 Cookie: 前缀、带换行、带制表符）自动纠正成合法 Cookie 串。
 *
 * 安全红线：任何情况下都不打印 Cookie 内容。日志是公开可查的。
 *
 * 退出码：0 成功（含"今日已签到"）；1 失败（Cookie 失效 / 网络异常 / 接口报错）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const APP_ID = '250528';
const WEB = '5';
const VERSION = '2.0.0';

const API = {
  signin: `https://pan.baidu.com/rest/2.0/membership/level?app_id=${APP_ID}&web=${WEB}&method=signin`,
  question: `https://pan.baidu.com/act/v2/membergrowv2/getdailyquestion?app_id=${APP_ID}&web=${WEB}`,
  answer: (askId, answer) =>
    `https://pan.baidu.com/act/v2/membergrowv2/answerquestion?app_id=${APP_ID}&web=${WEB}` +
    `&ask_id=${encodeURIComponent(askId)}&answer=${encodeURIComponent(answer)}`,
  user: `https://pan.baidu.com/rest/2.0/membership/user?app_id=${APP_ID}&web=${WEB}&method=query`,
};

const HEADERS = {
  // 不要用 keep-alive：百度端会提前关闭连接，复用失效 socket 会抛 terminated
  Connection: 'close',
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  Referer: 'https://pan.baidu.com/wap/svip/growth/task',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** Cookie 失效的典型文案（百度同时存在"登录"和"登陆"两种写法） */
const COOKIE_DEAD_RE =
  /未\s*登\s*[录陆]|登\s*[录陆]\s*已过期|重新\s*登\s*[录陆]|请\s*重\s*新\s*登|用户不存在|no\s*login|not\s*login/i;

/** 代表未登录/过期的 errno */
const AUTH_ERRNO = new Set([-6, 2, 10, 111]);

/**
 * "今天已经做过了" —— 这不是失败，属正常的幂等结果。
 * 百度返回的是英文文案，中文正则匹配不到，所以用 errno 白名单兜底：
 *   421001 → repeat signin（今日已签到）
 *   9502   → ask answer num exceeded limit（今日答题次数已用完）
 */
const ALREADY_ERRNO = new Set([421001, 9502]);
const ALREADY_RE =
  /已签|已答|已领|已打卡|今日已|重复|repeat|already|duplicat|exceed|no\s*times|times\s*limit/i;

const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || '';

// ===================== WxPusher推送函数 POST JSON 版本 =====================
async function sendWxPusher(title, desp) {
  const spt = (process.env.WXPUSHER_SPT || '').trim();
  if (!spt) {
    console.log('⚠️ 未配置 WXPUSHER_SPT，跳过 WxPusher 推送');
    return;
  }
  try {
    const res = await fetch('https://wxpusher.zjiecode.com/api/send/message/simple-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: desp,
        summary: title.slice(0, 100),
        contentType: 1,
        spt,
      }),
    });
    if (!res.ok) {
      console.log('❌ WxPusher推送失败：HTTP', res.status);
      return;
    }
    const result = await res.json();
    // HTTP 200 仍可能携带业务错误，成功码为 1000。
    if (result && result.code === 1000) {
      console.log('✅ WxPusher推送请求已受理');
    } else {
      console.log('❌ WxPusher推送失败：code=', result?.code ?? '未知');
    }
  } catch (err) {
    console.log('❌ WxPusher推送异常：', err.name);
  }
}
// =====================================================================

// ---------------------------------------------------------------- 输出层

/** GitHub Actions 会把 ::error:: 渲染成红色标注，普通人不用翻日志就能看到原因 */
function annotate(level, msg) {
  if (IN_ACTIONS) console.log(`::${level}::${String(msg).replace(/\r?\n/g, ' ')}`);
}

function say(msg) {
  console.log(msg);
}

function writeSummary(lines) {
  if (!SUMMARY_FILE) return;
  try {
    fs.appendFileSync(SUMMARY_FILE, lines.join('\n') + '\n', 'utf8');
  } catch {
    /* 摘要写失败不影响主流程 */
  }
}

// ---------------------------------------------------------------- 工具函数

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 把用户可能粘贴的各种格式，统一纠正成合法 Cookie 串。
 * 这一步是新手的最大失败点：很多人只复制了 BDUSS 的值，或者复制了带制表符的整行。
 */
function normalizeCookie(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^cookie\s*:\s*/i, '').trim();

  // 形如 BDUSS=xxx 或 BDUSS<tab>xxx（DevTools 整行复制）
  const one = s.match(/^BDUSS\s*[=:]\s*(.+)$/i) || s.match(/^BDUSS\s+([^\s;]+)\s*$/i);
  if (one) return 'BDUSS=' + one[1].trim().replace(/;+$/, '');

  // 多个 key=value 用分号分隔 → 已经是完整 Cookie 串
  if (/;\s*[A-Za-z_][\w.-]*\s*=/.test(s)) {
    return s
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('; ');
  }

  // 其余情况当作裸 BDUSS 值
  return 'BDUSS=' + s.replace(/[\s;]+/g, '');
}

function readCookie() {
  const candidates = [
    ['env:BAIDU_COOKIE', process.env.BAIDU_COOKIE],
    ['env:BAIDU_BDUSS', process.env.BAIDU_BDUSS],
  ];
  for (const [source, val] of candidates) {
    if (val && String(val).trim()) return { value: normalizeCookie(val), source };
  }
  const file = path.join(process.cwd(), '.cookie');
  if (fs.existsSync(file)) {
    const raw = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .join('');
    if (raw) return { value: normalizeCookie(raw), source: 'file:.cookie' };
  }
  return { value: '', source: 'none' };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 在任意嵌套结构里按 key 名找第一个值（百度不同版本字段名不一致） */
function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) {
    if (keys.includes(k) && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const hit = deepFind(obj[k], keys);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function pickNumber(text, json, keys) {
  if (json) {
    const v = deepFind(json, keys);
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  }
  for (const k of keys) {
    const m = text.match(new RegExp(`${k}"\\s*:\\s*(-?\\d+)`));
    if (m) return Number(m[1]);
  }
  return undefined;
}

function pickString(text, json, keys) {
  if (json) {
    const v = deepFind(json, keys);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  for (const k of keys) {
    const m = text.match(new RegExp(`${k}"\\s*:\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return '';
}

function detectAuthIssue(text, json) {
  const errno = pickNumber(text, json, ['errno', 'error_code']);
  const msg = pickString(text, json, ['error_msg', 'show_msg', 'errmsg']);
  const dead = (typeof errno === 'number' && AUTH_ERRNO.has(errno)) || COOKIE_DEAD_RE.test(msg);
  return { dead, errno, msg };
}

function failFromResponse(name, r) {
  const auth = detectAuthIssue(r.text, r.json);
  if (auth.dead) {
    return { name, ok: false, cookieDead: true, msg: auth.msg || `errno=${auth.errno}` };
  }
  const code = pickNumber(r.text, r.json, ['error_code', 'errno']);
  const detail = [auth.msg, code !== undefined ? `error_code=${code}` : ''].filter(Boolean).join(' ').trim();
  const head = r.error || `HTTP ${r.status}`;
  return { name, ok: false, msg: detail ? `${head} · ${detail}` : head };
}

async function request(url, cookie, opts = {}) {
  const { retries = 2, timeout = 15000 } = opts;
  const headers = { ...HEADERS, Cookie: cookie };
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    let timer = null;
    try {
      const ac = new AbortController();
      timer = setTimeout(() => ac.abort(), timeout);
      // 必须 manual：无权限时百度返回 302，自动跟随会抛 terminated，
      // 而真正的错误信息就在 302 的响应体里（如 {"error_code":36003,"error_msg":"no authority"}）
      const resp = await fetch(url, { headers, signal: ac.signal, redirect: 'manual' });
      const text = await resp.text();
      clearTimeout(timer);
      if (resp.status === 200) return { ok: true, status: resp.status, text, json: tryJson(text) };
      const location = resp.headers.get('location') || '';
      lastErr = location ? `HTTP ${resp.status} → ${location}` : `HTTP ${resp.status}`;
      return { ok: false, status: resp.status, text, json: tryJson(text), error: lastErr };
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? `请求超时(${timeout}ms)` : e.message;
    }
  }
  return { ok: false, status: 0, text: '', json: null, error: lastErr || 'unknown' };
}

// ---------------------------------------------------------------- 三个动作

async function doSignin(cookie, ctx = {}) {
  const r = await request(API.signin, cookie);
  if (!r.ok) {
    const res = failFromResponse('签到', r);
    // 实测：签到接口必须同时有 BDUSS 和 STOKEN，缺一个就返回 400 Param error（100002）。
    // 这是新手最常见的失败原因——只复制了 BDUSS 的值，没复制整行 Cookie。
    const code = pickNumber(r.text, r.json, ['error_code', 'errno']);
    if (code === 100002 && ctx.incomplete) {
      res.msg = 'Cookie 不完整（缺少 STOKEN 字段），请复制完整的一整行 Cookie，而不是只复制 BDUSS';
      res.cookieIncomplete = true;
    }
    return res;
  }

  const auth = detectAuthIssue(r.text, r.json);
  if (auth.dead) {
    return { name: '签到', ok: false, cookieDead: true, msg: auth.msg || `errno=${auth.errno}` };
  }

  const points = pickNumber(r.text, r.json, ['points', 'point', 'score', 'sign_point']);
  if (typeof auth.errno === 'number' && auth.errno !== 0) {
    const already = ALREADY_ERRNO.has(auth.errno) || ALREADY_RE.test(auth.msg);
    return {
      name: '签到',
      ok: already,
      already,
      msg: already ? '今日已签到（重复执行，正常）' : `errno=${auth.errno} ${auth.msg}`.trim(),
    };
  }
  return {
    name: '签到',
    ok: true,
    msg: typeof points === 'number' ? `签到成功，获得积分 ${points}` : '签到成功',
    points,
  };
}

async function doQuestion(cookie) {
  const q = await request(API.question, cookie);
  if (!q.ok) return failFromResponse('答题', q);

  // 未登录时此接口也返回 200，但 errno 非 0，不能当成"今天没题"
  const auth = detectAuthIssue(q.text, q.json);
  if (auth.dead) {
    return { name: '答题', ok: false, cookieDead: true, msg: auth.msg || `errno=${auth.errno}` };
  }
  if (typeof auth.errno === 'number' && auth.errno !== 0) {
    const already = ALREADY_ERRNO.has(auth.errno) || ALREADY_RE.test(auth.msg);
    if (already) return { name: '答题', ok: true, already, msg: '今日已答题（重复执行，正常）' };
    return { name: '答题', ok: false, msg: `errno=${auth.errno} ${auth.msg}`.trim() };
  }

  const askId = pickNumber(q.text, q.json, ['ask_id', 'askId']);
  const answer = pickNumber(q.text, q.json, ['answer', 'right_answer', 'correct']);
  if (askId === undefined || answer === undefined) {
    return { name: '答题', ok: true, skipped: true, msg: '今日无可答题目，已跳过' };
  }

  const a = await request(API.answer(askId, answer), cookie);
  if (!a.ok) return failFromResponse('答题', a);

  const errno = pickNumber(a.text, a.json, ['errno']);
  const showMsg = pickString(a.text, a.json, ['show_msg', 'error_msg', 'errmsg']);
  const score = pickNumber(a.text, a.json, ['score', 'points', 'point']);

  if (typeof errno === 'number' && errno !== 0) {
    const already = ALREADY_ERRNO.has(errno) || ALREADY_RE.test(showMsg);
    if (!already && COOKIE_DEAD_RE.test(showMsg)) {
      return { name: '答题', ok: false, cookieDead: true, msg: showMsg };
    }
    return {
      name: '答题',
      ok: already,
      already,
      msg: already ? '今日已答题（重复执行，正常）' : `errno=${errno} ${showMsg}`.trim(),
    };
  }
  return {
    name: '答题',
    ok: true,
    msg: typeof score === 'number' ? `答题成功，获得积分 ${score}` : `答题成功 ${showMsg}`.trim(),
    score,
  };
}

async function doUserInfo(cookie) {
  const r = await request(API.user, cookie);
  if (!r.ok) return failFromResponse('成长值', r);

  const auth = detectAuthIssue(r.text, r.json);
  if (auth.dead) {
    return { name: '成长值', ok: false, cookieDead: true, msg: auth.msg || `errno=${auth.errno}` };
  }

  const level = pickNumber(r.text, r.json, ['current_level', 'level', 'member_level']);
  const value = pickNumber(r.text, r.json, ['current_value', 'growth', 'growth_value', 'value']);
  if (level === undefined && value === undefined) {
    return { name: '成长值', ok: false, msg: '接口返回内容无法识别（百度可能已改动接口）' };
  }
  return {
    name: '成长值',
    ok: true,
    msg: `会员等级 ${level ?? '未知'}，成长值 ${value ?? '未知'}`,
    level,
    growth: value,
  };
}

// ---------------------------------------------------------------- 主流程

const HELP = `
百度网盘每日签到 v${VERSION}

用法: node scripts/signin.js [选项]
  --check       只验证 Cookie 是否有效
  --no-answer   跳过每日答题
  --help        显示帮助

Cookie 配置（任选其一）：
  环境变量 BAIDU_COOKIE   完整 Cookie 串或只有 BDUSS 一段
  环境变量 BAIDU_BDUSS    只填 BDUSS 的值
  当前目录 .cookie 文件    仅本地调试用
`;

function noCookieHelp() {
  say('');
  say('未找到 Cookie，无法签到。');
  say('');
  say('在 GitHub 上使用时，请检查：');
  say('  1. 仓库 Settings → Secrets and variables → Actions');
  say('  2. 是否已添加名为 BAIDU_COOKIE 的 Secret');
  say('  3. Secret 的值应是完整的一整行 Cookie（必须同时包含 BDUSS 和 STOKEN）');
  say('');
  say('获取 Cookie 的方法见仓库 README「第三步」。');
  say('');
  annotate('error', '缺少 BAIDU_COOKIE。请到 Settings → Secrets and variables → Actions 添加。');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    say(HELP);
    return 0;
  }

  const checkOnly = argv.includes('--check');
  const doAnswer = !argv.includes('--no-answer');

  const { value: cookie, source } = readCookie();
  if (!cookie) {
    noCookieHelp();
    return 1;
  }
  // 完整性预检：签到接口实测必须同时有 BDUSS 和 STOKEN
  const hasBduss = /(^|;\s*)BDUSS=/.test(cookie);
  const hasStoken = /(^|;\s*)STOKEN=/.test(cookie);
  const incomplete = hasBduss && !hasStoken;
  if (!hasBduss) {
    annotate('warning', 'Cookie 里没有 BDUSS 字段，签到必然失败。请重新复制完整 Cookie。');
  } else if (incomplete) {
    annotate(
      'warning',
      'Cookie 缺少 STOKEN 字段，签到会返回 Param error。请在 Network 面板复制完整的一整行 Cookie。'
    );
  }

  const results = [];
  if (checkOnly) {
    results.push(await doUserInfo(cookie));
  } else {
    results.push(await doSignin(cookie, { incomplete }));
    await sleep(2500);
    if (doAnswer) results.push(await doQuestion(cookie));
    await sleep(1500);
    results.push(await doUserInfo(cookie));
  }

  const cookieDead = results.some((r) => r.cookieDead);
  const failed = results.filter((r) => !r.ok && !r.cookieDead);
  const allOk = results.every((r) => r.ok);

  say(`\n百度网盘每日签到 — ${today()}`);
  say('-'.repeat(46));
  for (const r of results) say(`${r.ok ? '[√]' : '[×]'} ${r.name}：${r.msg}`);
  say('-'.repeat(46));

  // ========== 拼接推送文本，调用WxPusher推送 ==========
  let pushContent = `百度网盘签到 — ${today()}\n`;
  for (const r of results) {
    pushContent += `${r.ok ? '[√]' : '[×]'} ${r.name}：${r.msg}\n`;
  }
  if (cookieDead) {
    pushContent += "\n⚠️ Cookie 已失效，需要重新获取更新！";
  } else if (failed.length) {
    pushContent += "\n⚠️ 部分任务失败，可以重试";
  } else {
    pushContent += "\n✅ 全部任务完成";
  }
  await sendWxPusher("百度网盘签到通知", pushContent);
  // =============================================

  if (cookieDead) {
    say('[!] Cookie 已失效，需要重新获取并更新 Secret（见 README「Cookie 失效怎么办」）');
    annotate(
      'error',
      'Cookie 已失效。请按 README「Cookie 失效了怎么办」重新获取完整 Cookie 并更新 Secret BAIDU_COOKIE。'
    );
  } else if (results.some((r) => r.cookieIncomplete)) {
    say('[!] Cookie 不完整：签到接口需要 BDUSS 和 STOKEN 两个字段同时存在。');
    say('    请在 F12 → Network → 任一 pan.baidu.com 请求 → Request Headers 里');
    say('    复制 Cookie 那一整行的全部内容（不要只复制 BDUSS）。');
    annotate('error', 'Cookie 不完整（缺 STOKEN）。请复制完整的一整行 Cookie 后更新 Secret。');
  } else if (failed.length) {
    say(`[!] ${failed.length} 项未成功。常见原因：百度接口变动 / 网络波动，可先手动重跑一次。`);
    annotate('error', `部分步骤失败：${failed.map((f) => `${f.name}(${f.msg})`).join('；')}`);
  } else {
    say('[√] 全部完成');
  }

  writeSummary([
    `## 百度网盘签到 ${today()}`,
    '',
    '| 步骤 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...results.map(
      (r) => `| ${r.name} | ${r.ok ? '✅ 成功' : '❌ 失败'} | ${String(r.msg).replace(/\|/g, '\\|')} |`
    ),
    '',
    cookieDead
      ? '> ⚠️ **Cookie 已失效**，请重新获取 BDUSS 并更新 Secret `BAIDU_COOKIE`。'
      : allOk
        ? '> ✅ 今日任务已完成。'
        : '> ⚠️ 有步骤未成功，可到 Actions 页面点「Re-run all jobs」重试。',
    '',
    `<sub>Cookie 来源：${source}</sub>`,
  ]);

  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[×] 未捕获异常：', e);
    annotate('error', `脚本异常：${e && e.message ? e.message : e}`);
    process.exit(1);
  });
