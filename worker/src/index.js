// tdx-parking-proxy：停車查詢網頁的無狀態轉發。
// - 不存任何金鑰、不記錄 header／body（不寫 console.log）。
// - token 不經過這裡（瀏覽器直接 POST TDX token 端點）。
// - 只放行下列 host＋path，其他一律 403，避免被當成開放 proxy。
// - 請求只帶縣市層級的路徑，不收經緯度。

// 允許的 Origin 由環境變數 ALLOWED_ORIGINS（逗號分隔）決定：
// 正式版只允許 wrangler.toml 的 ALLOWED_ORIGINS；本機開發用 .dev.vars 加 localhost
const origins = env => new Set(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));

const TDX_KINDS = new Set([
  'OffStreet/CarPark',
  'OffStreet/ParkingAvailability',
  'OnStreet/ParkingSegment',
  'OnStreet/ParkingSegmentAvailability',
  'OnStreet/ParkingSpot',               // 路邊每一格位置
  'OnStreet/ParkingSpotAvailability',   // 路邊每一格空／佔用
]);
const TDX_QUERY = new Set(['$format', '$select', '$orderby', '$top', '$skip', '$count', '$filter']);
const NTPC_DATASETS = new Set([
  'B1464EF0-9C7C-4A6F-ABF7-6BDF32847E68', // 位置
  'e09b35a5-a738-48cc-b0f5-570b67ad9c78', // 即時剩餘車位
]);
const MAX_BYTES = 8 * 1024 * 1024;
// 公車／軌道（全部是 TDX 基礎服務；不收 $spatialFilter、不放行 advanced／NearBy）
const BUS_CITIES = new Set(['Taipei','NewTaipei','Taoyuan','Taichung','Tainan','Kaohsiung','Keelung','Hsinchu','HsinchuCounty','MiaoliCounty','ChanghuaCounty','NantouCounty','YunlinCounty','ChiayiCounty','Chiayi','PingtungCounty','YilanCounty','HualienCounty','TaitungCounty','KinmenCounty','PenghuCounty','LienchiangCounty']);
const METRO_SYSTEMS = new Set(['TRTC','KRTC','TYMC','KLRT','NTDLRT','TRTCMG','TMRT','NTMC','NTALRT']);
const METRO_LIVE = new Set(['TRTC','KRTC','TYMC','KLRT']);
const TRANSIT_SELECT = {
  busStation: 'StationUID,StationName,StationPosition,Stops',
  busEta: 'StopUID,StopName,RouteName,Direction,EstimateTime,StopStatus,SrcUpdateTime,UpdateTime',
  traStation: 'StationID,StationName,StationPosition',
  thsrStation: 'StationID,StationName,StationPosition',
  metroStation: 'StationID,StationName,StationPosition',
};
// StopUID：業管機關簡碼（3 個大寫字母）＋站牌代碼；不允許引號、空白
const STOP_UID = "[A-Z]{3}[0-9A-Za-z_-]{1,16}";
const BUS_FILTER = new RegExp(`^StopUID eq '${STOP_UID}'(?: or StopUID eq '${STOP_UID}'){0,39}$`);
// 只允許 $select（固定字串，可省略）、$format=JSON、$top／$skip（數字）、$filter（只有公車到站）
function transitQuery(q, select, allowFilter) {
  const keys = [...q.keys()];
  if (new Set(keys).size !== keys.length) return false;
  for (const k of keys) {
    if (k === '$select') { if (q.get(k) !== select) return false; }
    else if (k === '$format') { if (q.get(k) !== 'JSON') return false; }
    else if (k === '$top') { if (!/^\d{1,4}$/.test(q.get(k)) || +q.get(k) > 5000 || +q.get(k) < 1) return false; }
    else if (k === '$skip') { if (!/^\d{1,5}$/.test(q.get(k))) return false; }
    else if (k === '$filter' && allowFilter) { if (!BUS_FILTER.test(q.get(k))) return false; }
    else return false;
  }
  return true;
}
function transitTarget(p, q, search) {
  const T = 'https://tdx.transportdata.tw/api/basic';
  const ok = href => ({ tdx: true, href: href + search });   // 原樣轉送已驗過的 query
  let m = p.match(/^\/tdx\/api\/basic\/v2\/Bus\/(Station|EstimatedTimeOfArrival)\/City\/([A-Za-z]+)$/);
  if (m && BUS_CITIES.has(m[2])) {
    const eta = m[1] === 'EstimatedTimeOfArrival';
    if (eta && !q.has('$filter')) return null;     // 到站一定要帶站牌篩選，不給整個縣市
    return transitQuery(q, TRANSIT_SELECT[eta ? 'busEta' : 'busStation'], eta) ? ok(`${T}/v2/Bus/${m[1]}/City/${m[2]}`) : null;
  }
  if (p === '/tdx/api/basic/v3/Rail/TRA/Station') return transitQuery(q, TRANSIT_SELECT.traStation, false) ? ok(`${T}/v3/Rail/TRA/Station`) : null;
  m = p.match(/^\/tdx\/api\/basic\/v3\/Rail\/TRA\/(StationLiveBoard\/Station|DailyStationTimetable\/Today\/Station)\/(\d{4})$/);
  if (m) return transitQuery(q, null, false) ? ok(`${T}/v3/Rail/TRA/${m[1]}/${m[2]}`) : null;
  if (p === '/tdx/api/basic/v2/Rail/THSR/Station') return transitQuery(q, TRANSIT_SELECT.thsrStation, false) ? ok(`${T}/v2/Rail/THSR/Station`) : null;
  m = p.match(/^\/tdx\/api\/basic\/v2\/Rail\/THSR\/DailyTimetable\/Station\/(\d{4})\/(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))$/);
  if (m) return transitQuery(q, null, false) ? ok(`${T}/v2/Rail/THSR/DailyTimetable/Station/${m[1]}/${m[2]}`) : null;
  m = p.match(/^\/tdx\/api\/basic\/v2\/Rail\/Metro\/(Station|LiveBoard)\/([A-Z]+)$/);
  if (m && (m[1] === 'Station' ? METRO_SYSTEMS : METRO_LIVE).has(m[2])) {
    return transitQuery(q, m[1] === 'Station' ? TRANSIT_SELECT.metroStation : null, false) ? ok(`${T}/v2/Rail/Metro/${m[1]}/${m[2]}`) : null;
  }
  return null;
}

// ---- 路邊停車費查詢（TDX 第三方服務「全國路邊停車費查詢API」）----
// 上游網址照 https://tdx.transportdata.tw/data-service/parkingFee 逐字抄（2026-11-04）；只接受這 21 個
// 車牌是個資：只放在 POST body、不進網址、不記錄；每個 IP 有次數上限（PAYBILL_LIMIT binding）
import RULES from '../../shared/paybill_rules.json';   // 與 tw-relay 共用：上游網址、轉送縣市、車牌規則、timeout
const PAYBILL = RULES.paybill;
const RELAY_CITIES = new Set(RULES.relayCities);   // 從 Cloudflare 連不到、改經 台灣境內轉送站代查的縣市
// 規範 ERR02：只允許英數、中文與「-」
const PLATE = new RegExp(RULES.plate);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// body：{cities:["KHH",…], id:"ABC-1234", type:"C"|"M"}；回應逐縣市一行 JSON（NDJSON）：
// {city, ok:true, data:<上游 JSON>} 或 {city, ok:false, err:"status-522"|"network"|"timeout"|"too-large"|"not-json"}
// 經台灣境內轉送站 轉送：Tunnel 網址與密語都放 wrangler secret（RELAY_URL、RELAY_KEY）；沒設定或連不上一律 relay-down
// 警廣、消防局 119：Cloudflare 連不到（只收台灣 IP），改由 台灣境內轉送站固定上游轉送
const RELAY_GET = { '/pbs/roadData': 'pbs', '/fire/KHH': 'fire/KHH', '/fire/TNN': 'fire/TNN', '/fire/HCC': 'fire/HCC' };
async function relaySource(env, name, origin) {
  if (!env.RELAY_URL || !env.RELAY_KEY) return fail(503, 'relay-down', origin);
  const src = RULES.sources[name];
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), RULES.timeoutMs.workerToRelay);
    const r = await fetch(`${env.RELAY_URL}/${name}`, { headers: { 'X-Relay-Key': env.RELAY_KEY }, redirect: 'manual', signal: ctl.signal, cf: { cacheTtl: 0 } });
    const buf = await r.arrayBuffer(); clearTimeout(timer);
    if (r.status === 502) return fail(502, 'upstream', origin);   // 轉送站在線、對方網站壞
    if (r.status !== 200 || buf.byteLength > src.maxBytes * 2) return fail(502, 'relay-down', origin);
    const type = src.kind === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
    return new Response(buf, { status: 200, headers: { ...cors(origin), 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Upstream': 'relay', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return fail(502, 'relay-down', origin); }
}
async function viaRelay(env, city, id, type) {
  if (!env.RELAY_URL || !env.RELAY_KEY) return { city, ok: false, err: 'relay-down' };
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), RULES.timeoutMs.workerToRelay);
    const r = await fetch(`${env.RELAY_URL}/paybill`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Key': env.RELAY_KEY },
      body: JSON.stringify({ city, id, type }), redirect: 'manual', signal: ctl.signal, cf: { cacheTtl: 0 } });
    const t = await r.text(); clearTimeout(timer);
    if (r.status !== 200 || t.length > 270000) return { city, ok: false, err: 'relay-down' };
    const j = JSON.parse(t);
    return j && j.city === city && typeof j.ok === 'boolean' ? j : { city, ok: false, err: 'relay-down' };
  } catch { return { city, ok: false, err: 'relay-down' }; }
}
async function paybill(request, env, origin) {
  // 沒有次數上限就不提供（fail closed）：避免設定漏掉時變成無限制的匿名查車牌代理
  if (!env.PAYBILL_LIMIT) return fail(503, 'no-limit', origin);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const { success } = await env.PAYBILL_LIMIT.limit({ key: ip });
  if (!success) return fail(429, 'limit', origin, { 'Retry-After': '60' });
  const len = +(request.headers.get('Content-Length') || 0);
  if (len > 512) return fail(413, 'body', origin);
  let b;
  try { const t = await request.text(); if (t.length > 512) return fail(413, 'body', origin); b = JSON.parse(t); } catch { return fail(400, 'body', origin); }
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['cities', 'id', 'type'].includes(k))) return fail(403, 'body', origin);
  const { cities, id, type } = b;
  if (typeof id !== 'string' || !PLATE.test(id) || (type !== 'C' && type !== 'M')) return fail(403, 'plate', origin);
  if (!Array.isArray(cities) || !cities.length || cities.length > 21 || new Set(cities).size !== cities.length || cities.some(c => !Object.hasOwn(PAYBILL, c))) return fail(403, 'city', origin);
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  (async () => {
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      if (i) await sleep(RULES.gapMs);   // 規範：同一 IP 每秒最多 1 次
      let line;
      if (RELAY_CITIES.has(city)) {
        line = await viaRelay(env, city, id, type);
        try { await w.write(enc.encode(JSON.stringify(line) + '\n')); } catch { return; }
        continue;
      }
      try {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), RULES.timeoutMs.upstream);
        const up = await fetch(`${PAYBILL[city]}/CarID/${encodeURIComponent(id)}/CarType/${type}`,
          { headers: { Accept: 'application/json' }, redirect: 'manual', signal: ctl.signal, cf: { cacheTtl: 0 } });
        const buf = await up.arrayBuffer(); clearTimeout(timer);
        if (up.status !== 200) line = { city, ok: false, err: `status-${up.status}` };
        else if (buf.byteLength > 262144) line = { city, ok: false, err: 'too-large' };
        else { try { line = { city, ok: true, data: JSON.parse(new TextDecoder().decode(buf).replace(/^﻿/, '')) }; } catch { line = { city, ok: false, err: 'not-json' }; } }
      } catch (e) { line = { city, ok: false, err: e && e.name === 'AbortError' ? 'timeout' : 'network' }; }
      try { await w.write(enc.encode(JSON.stringify(line) + '\n')); } catch { return; }   // 使用者取消就停止
    }
    try { await w.close(); } catch {}
  })();
  return new Response(readable, { status: 200, headers: { ...cors(origin), 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Upstream': 'ok' } });
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Expose-Headers': 'X-Upstream, Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function fail(status, upstream, origin, extra = {}) {
  return new Response(null, { status, headers: { ...cors(origin), 'X-Upstream': upstream, ...extra } });
}

// 把對外路徑換成上游網址；不在白名單就回 null
function target(url) {
  const p = url.pathname;
  let m = p.match(/^\/tdx\/api\/basic\/v1\/Parking\/((?:OffStreet|OnStreet)\/[A-Za-z]+)\/City\/([A-Za-z]+)$/);
  if (m && TDX_KINDS.has(m[1])) {
    for (const k of url.searchParams.keys()) if (!TDX_QUERY.has(k)) return null;
    return { tdx: true, href: `https://tdx.transportdata.tw/api/basic/v1/Parking/${m[1]}/City/${m[2]}${url.search}` };
  }
  // YouBike：TDX 公共自行車 v2，只放行站點與即時數量兩個端點
  m = p.match(/^\/tdx\/api\/basic\/v2\/Bike\/(Station|Availability)\/City\/([A-Za-z]+)$/);
  if (m) {
    for (const k of url.searchParams.keys()) if (!TDX_QUERY.has(k)) return null;
    return { tdx: true, href: `https://tdx.transportdata.tw/api/basic/v2/Bike/${m[1]}/City/${m[2]}${url.search}` };
  }
  // 即時路況：國道／省道 路段即時車速、線型、路名，以及國道事件
  m = p.match(/^\/tdx\/api\/basic\/v2\/Road\/Traffic\/(Live|SectionShape|Section)\/(Freeway|Highway)$/) ||
      p.match(/^\/tdx\/api\/basic\/v2\/Road\/Traffic\/(Live\/News)\/(Freeway)$/);
  if (m) {
    for (const k of url.searchParams.keys()) if (!TDX_QUERY.has(k)) return null;
    return { tdx: true, href: `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/${m[1]}/${m[2]}${url.search}` };
  }
  m = p.match(/^\/ntpc\/([0-9A-Za-z-]+)\/json$/);
  if (m && NTPC_DATASETS.has(m[1])) {
    const page = url.searchParams.get('page') ?? '', size = url.searchParams.get('size') ?? '';
    if (!/^\d{1,2}$/.test(page) || !/^\d{1,4}$/.test(size) || [...url.searchParams.keys()].length !== 2) return null;
    return { tdx: false, href: `https://data.ntpc.gov.tw/api/datasets/${m[1]}/json?page=${page}&size=${size}` };
  }
  // 警廣即時路況（data.gov.tw 15221）改經 台灣境內轉送站，見 RELAY_GET
  // 國道即時道路事件（TDX 道路事件 v1）：只放行 Freeway 一條；只收 $format=JSON 與 $top，不收 $select／$filter
  if (p === '/tdx/api/basic/v1/Traffic/RoadEvent/LiveEvent/Freeway') {
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || url.searchParams.get('$format') !== 'JSON') return null;
    for (const k of keys) {
      if (k === '$format') continue;
      if (k === '$top' && /^\d{1,4}$/.test(url.searchParams.get(k)) && +url.searchParams.get(k) >= 1 && +url.searchParams.get(k) <= 2000) continue;
      return null;
    }
    return { tdx: true, href: `https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/Freeway${url.search}` };
  }
  if (p.startsWith('/tdx/api/basic/v2/Bus/') || p.startsWith('/tdx/api/basic/v3/Rail/') || p.startsWith('/tdx/api/basic/v2/Rail/')) return transitTarget(p, url.searchParams, url.search);
  if (p === '/hccg/GetParkInfo' && url.search === '') {
    return { tdx: false, href: 'https://hispark.hccg.gov.tw/OpenData/GetParkInfo' };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!origins(env).has(origin)) return new Response(null, { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (new URL(request.url).pathname === '/paybill') return request.method === 'POST' ? paybill(request, env, origin) : fail(405, 'method', origin);
    if (request.method !== 'GET') return fail(405, 'method', origin);
    { const u = new URL(request.url); if (Object.hasOwn(RELAY_GET, u.pathname) && u.search === '') return relaySource(env, RELAY_GET[u.pathname], origin); }

    const t = target(new URL(request.url));
    if (!t) return fail(403, 'path', origin);

    const headers = { Accept: t.tdx ? 'application/json' : 'application/json, text/csv' };
    // 只有 TDX 才轉送 Authorization；地方政府來源永遠不帶認證
    if (t.tdx) {
      const auth = request.headers.get('Authorization');
      if (auth && /^Bearer [\w.-]+$/.test(auth)) headers.Authorization = auth;
    }

    let up;
    try {
      up = await fetch(t.href, { headers, redirect: 'manual', cf: { cacheTtl: 0 } });
    } catch {
      return fail(502, 'network', origin);
    }
    if (up.status !== 200) {
      const extra = up.headers.get('Retry-After') ? { 'Retry-After': up.headers.get('Retry-After') } : {};
      return fail(up.status === 401 || up.status === 403 || up.status === 429 || up.status === 400 ? up.status : 502,
        `status-${up.status}`, origin, extra);
    }
    const buf = await up.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return fail(502, 'too-large', origin);
    const head = new TextDecoder().decode(buf.slice(0, 4096)).trimStart().toLowerCase();
    if (head.startsWith('<') && (head.includes('request rejected') || head.includes('access denied'))) {
      return fail(502, 'rejected', origin);
    }
    return new Response(buf, {
      status: 200,
      headers: { ...cors(origin), 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', 'X-Upstream': 'ok' },
    });
  },
};
