// Owen.gg - LoL 전적 검색 로컬 서버 (의존성 없음, Node 18+)
// 실행: node server.js  ->  http://localhost:3000
// API 키: 환경변수 RIOT_API_KEY 또는 config.json {"riotApiKey":"RGAPI-..."} 또는 사이트 설정에서 입력
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const REGION = {
  kr: 'asia', jp1: 'asia',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};
const accountRegion = (pf) => (REGION[pf] === 'sea' ? 'asia' : REGION[pf]);

const CONFIG = path.join(ROOT, 'config.json');
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } }
function configKey() { return readConfig().riotApiKey || ''; }
function writeConfig(o) { fs.writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), ...o }, null, 2)); }
/* 키 상태: 유효성은 5분마다 캐시 */
const keyState = { valid: null, checkedAt: 0, key: '' };
async function probeKey(key) {
  try { const r = await fetch('https://kr.api.riotgames.com/lol/status/v4/platform-data', { headers: { 'X-Riot-Token': key } }); return r.ok ? true : (r.status === 401 || r.status === 403 ? false : null); }
  catch { return null; }
}
async function keyValidity(force = false) {
  const k = serverKey(); if (!k) return null;
  if (!force && keyState.key === k && Date.now() - keyState.checkedAt < 300000) return keyState.valid;
  const v = await probeKey(k); keyState.key = k; keyState.checkedAt = Date.now(); keyState.valid = v; return v;
}
const CLOUD_KEY_URL = 'https://crrsswrrdpzmdlrgkfoi.supabase.co/functions/v1/owen-riot/key';
async function syncCloud() {
  const c = readConfig(); if (!c.ownerToken || !c.riotApiKey) return { ok: false, error: '소유자 코드 또는 키가 없습니다.' };
  try { const r = await fetch(CLOUD_KEY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner-token': c.ownerToken }, body: JSON.stringify({ key: c.riotApiKey }) }); const d = await r.json().catch(() => ({})); return r.ok ? { ok: true } : { ok: false, error: d.error || ('클라우드 오류 ' + r.status) }; }
  catch { return { ok: false, error: '클라우드 서버에 연결할 수 없습니다.' }; }
}
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function readBody(req) { return new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); }); }
const serverKey = () => process.env.RIOT_API_KEY || configKey();

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---- cache ----
const cache = new Map();
function cGet(k) {
  const e = cache.get(k); if (!e) return undefined;
  if (e.exp !== Infinity && e.exp < Date.now()) { cache.delete(k); return undefined; }
  return e.v;
}
function cSet(k, v, ttl) {
  if (!(ttl > 0)) return;
  cache.set(k, { v, exp: ttl === Infinity ? Infinity : Date.now() + ttl });
  if (cache.size > 8000) cache.delete(cache.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ERR = {
  400: '잘못된 요청입니다.',
  401: 'API 키가 만료되었거나 잘못되었습니다. 개발용 키는 24시간마다 만료되니 developer.riotgames.com에서 REGENERATE API KEY로 새 키를 받아 넣어 주세요.',
  403: 'API 키가 만료되었거나 권한이 없습니다. developer.riotgames.com에서 REGENERATE API KEY로 새 키를 받아 넣어 주세요.',
  404: 'NOT_FOUND',
  500: 'Riot 서버 오류입니다. 잠시 후 다시 시도하세요.',
  503: 'Riot 서버 점검 중입니다.',
};

async function riot(url, key, ttl = 60000, fresh = false) {
  if (!key) throw new ApiError(401, ERR[401]);
  if (!fresh) { const c = cGet(url); if (c !== undefined) return c; }
  for (let i = 0; i < 4; i++) {
    let res;
    try { res = await fetch(url, { headers: { 'X-Riot-Token': key } }); }
    catch { throw new ApiError(502, 'Riot 서버에 연결할 수 없습니다.'); }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') || 1);
      await sleep(Math.min(ra, 10) * 1000 + 250);
      continue;
    }
    if (!res.ok) throw new ApiError(res.status, ERR[res.status] || `Riot API 오류 (${res.status})`);
    const data = await res.json();
    cSet(url, data, ttl);
    return data;
  }
  throw new ApiError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
}

const enc = encodeURIComponent;
function plat(p) {
  if (!REGION[p]) throw new ApiError(400, '지원하지 않는 서버입니다.');
  return p;
}

const routes = {
  async status() {
    const k = serverKey(), cfg = readConfig();
    const appliedAt = k && k === cfg.riotApiKey ? cfg.appliedAt || null : null;
    return { ok: true, hasServerKey: !!k, keyValid: await keyValidity(), appliedAt, expiresAt: appliedAt ? appliedAt + 24 * 3600 * 1000 : null, keyTail: k ? k.slice(-4) : '' };
  },

  async validate(q, key) {
    const pf = plat(q.platform || 'kr');
    await riot(`https://${pf}.api.riotgames.com/lol/status/v4/platform-data`, key, 0, true);
    return { ok: true };
  },

  async profile(q, key) {
    const pf = plat(q.platform);
    const fresh = q.fresh === '1';
    if (!q.name || !q.tag) throw new ApiError(400, '이름#태그 형식으로 입력하세요.');
    let acc;
    try {
      acc = await riot(`https://${accountRegion(pf)}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${enc(q.name)}/${enc(q.tag)}`, key, 300000, fresh);
    } catch (e) {
      if (e.status === 404) throw new ApiError(404, '소환사를 찾을 수 없습니다. 이름#태그와 서버를 확인하세요.');
      throw e;
    }
    const base = `https://${pf}.api.riotgames.com`;
    let summoner;
    try { summoner = await riot(`${base}/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`, key, 60000, fresh); }
    catch (e) {
      if (e.status === 404) throw new ApiError(404, '해당 서버에 소환사 기록이 없습니다. 서버(지역)를 확인하세요.');
      throw e;
    }
    const [league, mastery] = await Promise.all([
      riot(`${base}/lol/league/v4/entries/by-puuid/${acc.puuid}`, key, 60000, fresh).catch(() => []),
      riot(`${base}/lol/champion-mastery/v4/champion-masteries/by-puuid/${acc.puuid}/top?count=10`, key, 300000, fresh).catch(() => []),
    ]);
    return { account: acc, summoner, league, mastery, platform: pf };
  },

  async matches(q, key) {
    const pf = plat(q.platform);
    const start = Math.max(0, parseInt(q.start) || 0);
    const count = Math.min(100, Math.max(1, parseInt(q.count) || 20));
    let u = `https://${REGION[pf]}.api.riotgames.com/lol/match/v5/matches/by-puuid/${enc(q.puuid)}/ids?start=${start}&count=${count}`;
    if (q.queue && /^\d+$/.test(q.queue)) u += `&queue=${q.queue}`;
    const fresh = q.fresh === '1';
    return riot(u, key, 30000, fresh);
  },

  async match(q, key) {
    const pf = plat(q.platform);
    if (!/^[A-Z0-9]+_\d+$/.test(q.id || '')) throw new ApiError(400, '잘못된 매치 ID');
    return riot(`https://${REGION[pf]}.api.riotgames.com/lol/match/v5/matches/${q.id}`, key, Infinity);
  },

  async live(q, key) {
    const pf = plat(q.platform);
    try {
      return await riot(`https://${pf}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${enc(q.puuid)}`, key, 0, true);
    } catch (e) {
      if (e.status === 404) throw new ApiError(404, '현재 게임 중이 아닙니다.');
      throw e;
    }
  },

  async ranking(q, key) {
    const pf = plat(q.platform);
    const queue = q.queue === 'flex' ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';
    const tier = { challenger: 'challengerleagues', grandmaster: 'grandmasterleagues', master: 'masterleagues' }[q.tier] || 'challengerleagues';
    const d = await riot(`https://${pf}.api.riotgames.com/lol/league/v4/${tier}/by-queue/${queue}`, key, 120000);
    const entries = (d.entries || []).sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, 200);
    return { tier: d.tier, queue, entries };
  },

  async account(q, key) {
    const pf = plat(q.platform);
    return riot(`https://${accountRegion(pf)}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${enc(q.puuid)}`, key, Infinity);
  },

  async rotation(q, key) {
    const pf = plat(q.platform);
    return riot(`https://${pf}.api.riotgames.com/lol/platform/v3/champion-rotations`, key, 3600000);
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  /* 새 개발 키 적용: 활성화될 때까지 최대 약 70초 재시도 후 config.json에 저장 (로컬에서만 허용) */
  if (u.pathname === '/api/key' && req.method === 'POST') {
    if (!isLocal(req)) return send(res, 403, { error: '로컬에서만 키를 바꿀 수 있습니다.' });
    const { key } = await readBody(req);
    const k = String(key || '').trim();
    if (!/^RGAPI-[0-9a-f-]{36}$/i.test(k)) return send(res, 400, { error: '키 형식이 올바르지 않습니다. (RGAPI-로 시작하는 키)' });
    let v = null;
    for (let i = 0; i < 8; i++) { v = await probeKey(k); if (v) break; await new Promise((r) => setTimeout(r, 10000)); }
    if (!v) return send(res, 400, { error: v === false ? '이 키는 유효하지 않거나 이미 만료되었습니다. Riot 페이지에서 REGENERATE 후 새 키를 복사해 주세요.' : 'Riot 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.' });
    const prev = readConfig();
    const appliedAt = prev.riotApiKey === k && prev.appliedAt ? prev.appliedAt : Date.now();
    writeConfig({ riotApiKey: k, appliedAt });
    keyState.key = k; keyState.valid = true; keyState.checkedAt = Date.now(); cache.clear?.();
    console.log('[key] 새 API 키 적용 (…' + k.slice(-4) + ')');
    syncCloud().then((r) => console.log('[key] 클라우드 동기화', r.ok ? '완료' : '실패: ' + r.error));
    return send(res, 200, { ok: true, appliedAt, expiresAt: appliedAt + 24 * 3600 * 1000, keyTail: k.slice(-4) });
  }
  /* 소유자 코드 저장 + 현재 키를 클라우드(공개 주소)에 동기화 */
  if (u.pathname === '/api/key-sync' && req.method === 'POST') {
    if (!isLocal(req)) return send(res, 403, { error: '로컬에서만 가능합니다.' });
    const { owner } = await readBody(req);
    writeConfig({ ownerToken: String(owner || '').trim() });
    if (!owner) return send(res, 200, { ok: true });
    const r = await syncCloud();
    return send(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
  }
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5);
    const fn = routes[name];
    if (!fn) return send(res, 404, { error: '없는 API입니다.' });
    const key = (req.headers['x-riot-key'] || '').trim() || serverKey();
    try { send(res, 200, await fn(Object.fromEntries(u.searchParams), key)); }
    catch (e) {
      const st = e.status || 500;
      if (st >= 500) console.error('[api]', name, e.message);
      send(res, st, { error: e.message || '서버 오류', code: st });
    }
    return;
  }
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || !MIME[path.extname(file)] || path.basename(file) === 'config.json') return send(res, 404, 'Not found', 'text/plain');
  const ext = path.extname(file);
  if (ext === '.mp4' || ext === '.webm') {
    /* 영상은 Range 요청 지원 (반복 재생·탐색 안정화) */
    return fs.stat(file, (err, st) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (!m) { res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' }); return fs.createReadStream(file).pipe(res); }
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]); const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { 'Content-Type': MIME[ext], 'Content-Length': end - start + 1, 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(file, { start, end }).pipe(res);
    });
  }
  fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)]));
}).listen(PORT, () => {
  console.log(`\n  Owen.gg 실행 중:  http://localhost:${PORT}`);
  console.log(`  서버 API 키: ${serverKey() ? '설정됨' : '없음 (사이트 설정에서 입력 가능)'}\n`);
});
