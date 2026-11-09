// supabase/functions/owen-riot/index.ts
// Owen.gg 클라우드 프록시: Riot API 호출 + 개발 키 저장/자동 적용
// - 전적 조회는 누구나(친구 공유용), 키 변경은 소유자 코드(OWNER_TOKEN)가 있는 운영자만
// - 키는 DB(public.riot_config)에 저장되어 즉시 적용됨
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const OWNER = Deno.env.get("OWNER_TOKEN") ?? "";
function firstKey(jsonEnv: string, legacyEnv: string): string {
  try { const o = JSON.parse(Deno.env.get(jsonEnv) ?? "{}"); const v = o.default ?? Object.values(o)[0]; if (typeof v === "string" && v) return v; } catch { /* */ }
  return Deno.env.get(legacyEnv) ?? "";
}
const SVC = firstKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const svcH = (): Record<string, string> => { const h: Record<string, string> = { apikey: SVC, "Content-Type": "application/json" }; if (SVC.startsWith("eyJ")) h.Authorization = "Bearer " + SVC; return h; };
const ORIGINS = ["https://jake12733.github.io"];
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return { "Access-Control-Allow-Origin": ok ? o : ORIGINS[0], "Access-Control-Allow-Headers": "content-type, x-owner-token, x-riot-key, apikey, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
const REGION = {
  kr: 'asia', jp1: 'asia',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};
const accountRegion = (pf) => (REGION[pf] === 'sea' ? 'asia' : REGION[pf]);

/* ---- 키 저장소 (DB) ---- */
let kc: { key: string; appliedAt: number; at: number } | null = null;
async function loadKey(force = false) {
  if (!force && kc && Date.now() - kc.at < 30000) return kc;
  const r = await fetch(SUPABASE_URL + "/rest/v1/riot_config?id=eq.1&select=api_key,applied_at", { headers: svcH() });
  const row = r.ok ? (await r.json())[0] : null;
  kc = { key: row?.api_key ?? "", appliedAt: Number(row?.applied_at ?? 0), at: Date.now() };
  return kc;
}
async function saveKey(key: string, appliedAt: number) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/riot_config?on_conflict=id", { method: "POST", headers: { ...svcH(), Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ id: 1, api_key: key, applied_at: appliedAt }) });
  if (!r.ok) throw new Error("키 저장 실패: " + r.status);
  kc = { key, appliedAt, at: Date.now() };
}
async function probeKey(key: string): Promise<boolean | null> {
  try { const r = await fetch("https://kr.api.riotgames.com/lol/status/v4/platform-data", { headers: { "X-Riot-Token": key } }); return r.ok ? true : (r.status === 401 || r.status === 403 ? false : null); } catch { return null; }
}
let vc: { key: string; v: boolean | null; at: number } | null = null;
async function validity(key: string) { if (vc && vc.key === key && Date.now() - vc.at < 300000) return vc.v; const v = await probeKey(key); vc = { key, v, at: Date.now() }; return v; }

/* ---- Riot 호출 (로컬 server.js와 동일 로직) ---- */
class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

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


const KEEP_P = new Set(["assists","baronKills","champLevel","championId","championName","championTransform","damageDealtToBuildings","damageDealtToObjectives","deaths","detectorWardsPlaced","doubleKills","dragonKills","firstBloodKill","gameEndedInEarlySurrender","goldEarned","goldSpent","individualPosition","inhibitorKills","item0","item1","item2","item3","item4","item5","item6","killingSprees","kills","lane","largestKillingSpree","largestMultiKill","magicDamageDealtToChampions","neutralMinionsKilled","pentaKills","perks","physicalDamageDealtToChampions","placement","playerAugment1","playerAugment2","playerAugment3","playerAugment4","playerSubteamId","profileIcon","puuid","quadraKills","riotIdGameName","riotIdTagline","role","subteamPlacement","summoner1Casts","summoner1Id","summoner2Casts","summoner2Id","summonerLevel","summonerName","teamId","teamPosition","timePlayed","totalDamageDealt","totalDamageDealtToChampions","totalDamageShieldedOnTeammates","totalDamageTaken","totalHeal","totalHealsOnTeammates","totalMinionsKilled","totalTimeSpentDead","tripleKills","trueDamageDealtToChampions","turretKills","visionScore","visionWardsBoughtInGame","wardsKilled","wardsPlaced","win"]);
function slimMatch(m: any) {
  if (!m || !m.info) return m;
  return { metadata: { matchId: m.metadata?.matchId }, info: { ...m.info, tournamentCode: undefined, participants: (m.info.participants || []).map((p) => { const o: Record<string, unknown> = {}; for (const k in p) if (KEEP_P.has(k)) o[k] = p[k]; return o; }) } };
}
const routes = {

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
    return slimMatch(await riot(`https://${REGION[pf]}.api.riotgames.com/lol/match/v5/matches/${q.id}`, key, Infinity));
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


Deno.serve(async (req) => {
  const H = cors(req);
  const json = (s: number, b: unknown, cc = "no-store") => new Response(JSON.stringify(b), { status: s, headers: { ...H, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cc } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  const u = new URL(req.url);
  const name = u.pathname.replace(/^.*\/owen-riot\/?/, "");
  const owner = !!OWNER && req.headers.get("x-owner-token") === OWNER;
  try {
    if (name === "status") {
      const k = await loadKey(true);
      const appliedAt = k.appliedAt || null;
      return json(200, { ok: true, cloud: true, owner, hasServerKey: !!k.key, keyValid: k.key ? await validity(k.key) : null, appliedAt, expiresAt: appliedAt ? appliedAt + 86400000 : null, keyTail: k.key ? k.key.slice(-4) : "" });
    }
    if (name === "key" && req.method === "POST") {
      if (!owner) return json(401, { error: "키 변경은 운영자만 할 수 있어요. (소유자 코드 필요)", code: 401 });
      const b = await req.json().catch(() => ({}));
      const k = String(b.key || "").trim();
      if (!/^RGAPI-[0-9a-f-]{36}$/i.test(k)) return json(400, { error: "키 형식이 올바르지 않습니다. (RGAPI-로 시작하는 키)" });
      let v: boolean | null = null;
      for (let i = 0; i < 7; i++) { v = await probeKey(k); if (v) break; await new Promise((r) => setTimeout(r, 8000)); }
      if (!v) return json(400, { error: v === false ? "이 키는 유효하지 않거나 이미 만료되었습니다. Riot 페이지에서 REGENERATE 후 새 키를 복사해 주세요." : "Riot 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요." });
      const prev = await loadKey(true);
      const appliedAt = prev.key === k && prev.appliedAt ? prev.appliedAt : Date.now();
      await saveKey(k, appliedAt); vc = { key: k, v: true, at: Date.now() }; cache.clear();
      return json(200, { ok: true, appliedAt, expiresAt: appliedAt + 86400000, keyTail: k.slice(-4) });
    }
    const fn = (routes as Record<string, (q: Record<string, string>, key: string) => Promise<unknown>>)[name];
    if (!fn) return json(404, { error: "없는 API입니다." });
    const key = (req.headers.get("x-riot-key") || "").trim() || (await loadKey()).key;
    const out = await fn(Object.fromEntries(u.searchParams), key);
    /* 끝난 매치는 바뀌지 않으므로 브라우저에 오래 캐시, 랭킹/로테이션은 짧게 */
    const cc = name === "match" || name === "account" ? "public, max-age=2592000, immutable" : name === "ranking" || name === "rotation" ? "public, max-age=120" : "no-store";
    return json(200, out, cc);
  } catch (e) {
    const st = (e as { status?: number }).status || 500;
    if (st === 401 || st === 403) vc = null;
    return json(st, { error: (e as Error).message || "서버 오류", code: st });
  }
});
