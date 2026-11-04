// tw-relay：台灣境內主機上的路邊停車費查詢轉送站
// - 只綁 127.0.0.1；外面只能經 Cloudflare Tunnel 進來，且要帶 X-Relay-Key（錯就回 404，不透露服務存在）
// - 路由：POST /paybill {city, id, type}（city 限 relayCities，車牌規則與 Worker 同一份 rules.json）；
//   GET /pbs、/fire/{KHH|TNN|HCC}：固定上游（rules.sources），快取 60 秒、限大小與型別
// - 不記錄：任何地方都不印 body、車牌、上游回應內容；log 只寫啟動／自測「縣市 通／不通」與錯誤種類
// - 同一上游間隔 ≥ gapMs；開機自測用不可能是車牌的「--」，10 分鐘內重啟不重測
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RULES = JSON.parse(fs.readFileSync(process.env.TW_RELAY_RULES || path.join(HERE, '../shared/paybill_rules.json'), 'utf8'));
const PLATE = new RegExp(RULES.plate);
const CITIES = new Set(RULES.relayCities);
const PORT = +(process.env.TW_RELAY_PORT || 8790);
const STATE_DIR = process.env.TW_RELAY_STATE || path.join(os.homedir(), 'Library/Application Support/tw-relay');
const log = (...a) => console.log(new Date().toISOString(), ...a);   // 只傳固定字串與縣市代碼進來

// 密語：relay_secret.txt（權限 600）裡的 key=…（或用 TW_RELAY_SECRET 指定路徑）；讀不到就不啟動
function readKey(){
  const f = process.env.TW_RELAY_SECRET || path.join(HERE, 'relay_secret.txt');
  const st = fs.statSync(f);
  if (st.mode & 0o077) throw new Error('secret file must be 600');
  const m = /^key=([A-Za-z0-9_-]{32,})$/m.exec(fs.readFileSync(f, 'utf8'));
  if (!m) throw new Error('secret file has no key=');
  return m[1];
}
const KEY = readKey();
// 先各自 sha256 再比：長度永遠相同，非 ASCII 的 key 也不會讓 timingSafeEqual 丟例外
const sha = v => crypto.createHash('sha256').update(String(v), 'utf8').digest();
const eq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// 同一上游間隔 ≥ gapMs（以縣市為單位排隊）
const lastHit = new Map(), queue = new Map();
function slot(city){
  const prev = queue.get(city) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = (lastHit.get(city) || 0) + RULES.gapMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastHit.set(city, Date.now());
  });
  queue.set(city, next.catch(() => {}));
  return next;
}
const down = new Set();   // 自測不通的縣市：直接回 relay-down，不讓使用者空等
async function upstream(city, id, type){
  await slot(city);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), RULES.timeoutMs.upstream);
  try {
    const r = await fetch(`${RULES.paybill[city]}/CarID/${encodeURIComponent(id)}/CarType/${type}`, {headers: {Accept: 'application/json'}, redirect: 'manual', signal: ctl.signal});
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) return {ok: false, err: `status-${r.status}`};
    if (buf.length > 262144) return {ok: false, err: 'too-large'};
    try { return {ok: true, data: JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))}; } catch { return {ok: false, err: 'not-json'}; }
  } catch (e) { return {ok: false, err: e && e.name === 'AbortError' ? 'timeout' : 'network'}; }
  finally { clearTimeout(timer); }
}

// 固定上游的 GET 來源：同一來源 60 秒內共用一份（含進行中的請求），避免多人同時查時連打上游
const SOURCES = RULES.sources || {};
const srcCache = new Map();
export async function source(name){
  const s = SOURCES[name];
  if (!s) return null;
  const hit = srcCache.get(name);
  if (hit && Date.now() - hit.at < RULES.sourceCacheMs) return hit.p;
  // 上游偶發 5xx／斷線（2026-11-04 15:22 高雄消防局回過一次 502）：隔 1 秒重試一次（逾時不重試，Worker 等 relay 只有 6.5 秒）
  // 只有第一次很快失敗（<1.5 秒）才重試，總時間才不會超過 Worker 的 6.5 秒
  const t0 = Date.now();
  const p = fetchSource(s).then(v => v.ok || !/^(status-5|network)/.test(v.err) || Date.now() - t0 >= 1500 ? v : new Promise(r => setTimeout(r, 1000)).then(() => fetchSource(s)));
  srcCache.set(name, {at: Date.now(), p});
  p.then(v => { if (!v.ok) srcCache.delete(name); });   // 失敗不快取，下次重試
  return p;
}
async function fetchSource(s){
  {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), RULES.timeoutMs.source);
    try {
      const r = await fetch(s.url, {redirect: 'manual', signal: ctl.signal});
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status !== 200) return {ok: false, err: `status-${r.status}`};
      if (buf.length > s.maxBytes) return {ok: false, err: 'too-large'};
      const text = buf.toString('utf8').replace(/^\uFEFF/, '');
      if (s.kind === 'json') { try { JSON.parse(text); } catch { return {ok: false, err: 'not-json'}; } }
      else if (!/text\/html/i.test(r.headers.get('content-type') || '')) return {ok: false, err: 'not-html'};
      return {ok: true, text, type: s.kind === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'};
    } catch (e) { return {ok: false, err: e && e.name === 'AbortError' ? 'timeout' : 'network'}; }
    finally { clearTimeout(timer); }
  }
}

export function validate(b){
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['city', 'id', 'type'].includes(k))) return false;
  return CITIES.has(b.city) && typeof b.id === 'string' && PLATE.test(b.id) && (b.type === 'C' || b.type === 'M');
}

const server = http.createServer((req, res) => { try { handle(req, res); } catch (e) { log('handler error', e && e.name); try { res.writeHead(404); res.end(); } catch {} } });
function handle(req, res){
  const send = (code, obj) => { res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(obj ? JSON.stringify(obj) : ''); };
  const key = String(req.headers['x-relay-key'] || '');
  if (!eq(key, KEY)) { req.resume(); return send(404); }
  if (req.method === 'GET' && Object.hasOwn(SOURCES, req.url.slice(1))) {
    req.resume();
    return void source(req.url.slice(1)).then(v => {
      if (res.writableEnded) return;
      if (!v.ok) { log('source', req.url.slice(1), v.err); return send(502, {ok: false, err: v.err}); }
      res.writeHead(200, {'Content-Type': v.type, 'Cache-Control': 'no-store'}); res.end(v.text);
    }, () => { if (!res.writableEnded) send(502, {ok: false, err: 'error'}); });
  }
  if (req.method !== 'POST' || req.url !== '/paybill') { req.resume(); return send(404); }
  let size = 0, chunks = [];
  req.on('data', c => { size += c.length; if (size > 512) { req.destroy(); } else chunks.push(c); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400); }
    if (!validate(b)) return send(400);
    if (down.has(b.city)) return send(200, {city: b.city, ok: false, err: 'relay-down'});
    const total = setTimeout(() => { if (!res.writableEnded) send(200, {city: b.city, ok: false, err: 'timeout'}); }, RULES.timeoutMs.relayTotal);
    const out = await upstream(b.city, b.id, b.type);
    clearTimeout(total);
    if (!res.writableEnded) send(200, {city: b.city, ...out});
  });
}
// 任何漏接的例外只記錯誤名稱、不讓 process 退出（避免被未授權請求反覆打掛）
process.on('uncaughtException', e => log('uncaught', e && e.name));
process.on('unhandledRejection', e => log('unhandled', e && e.name));

// 開機自測：10 分鐘內重啟沿用上次結果，避免 crash loop 連打上游
async function selftest(){
  const f = path.join(STATE_DIR, 'selftest.json');
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - s.at < 600000 && Array.isArray(s.down)) { s.down.forEach(c => down.add(c)); log('selftest: reuse', `down=${s.down.join(',') || '-'}`); return; }
  } catch {}
  const bad = [];
  for (const c of RULES.relayCities) {
    const r = await upstream(c, '--', 'C');   // 不可能是任何人的車牌
    if (!r.ok) { bad.push(c); down.add(c); }
    log('selftest', c, r.ok ? 'ok' : `down(${r.err})`);
  }
  fs.mkdirSync(STATE_DIR, {recursive: true});
  fs.writeFileSync(f, JSON.stringify({at: Date.now(), down: bad}));
}

if (process.env.TW_RELAY_NO_LISTEN !== '1') {
  server.listen(PORT, '127.0.0.1', () => log(`listening 127.0.0.1:${PORT}`));
  if (process.env.TW_RELAY_NO_SELFTEST !== '1') selftest().catch(e => log('selftest error', e.name));
  // 每 30 分鐘重測一次，讓暫時掛掉的縣市能恢復
  setInterval(() => { down.clear(); fs.rmSync(path.join(STATE_DIR, 'selftest.json'), {force: true}); selftest().catch(() => {}); }, 1800000).unref();
}
export {server};
