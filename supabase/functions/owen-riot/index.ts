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
/* ---- 통계 수집: 챔피언 분석·장인 랭킹용 (Riot에서 받은 실제 데이터만 서버가 저장) ---- */
const SR_Q = new Set([400, 420, 430, 440, 490]);
const collected = new Set<string>();
function bg(p: Promise<unknown>) { p.catch(() => {}); try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* */ } }
async function sbInsert(table: string, rows: unknown[], conflict: string, merge = false) {
  if (!rows.length || !SVC) return;
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, { method: "POST", headers: { ...svcH(), Prefer: `resolution=${merge ? "merge" : "ignore"}-duplicates,return=minimal` }, body: JSON.stringify(rows) }).catch(() => {});
}
function runesOf(p: any) {
  const s = p.perks?.styles || [], a = s[0], b = s[1], st = p.perks?.statPerks || {};
  if (!a) return null;
  const pa = (a.selections || []).map((x: any) => x.perk), pb = (b?.selections || []).map((x: any) => x.perk);
  return [a.style, pa[0] ?? 0, pa[1] ?? 0, pa[2] ?? 0, pa[3] ?? 0, b?.style ?? 0, pb[0] ?? 0, pb[1] ?? 0, st.offense ?? 0, st.flex ?? 0, st.defense ?? 0];
}
/* 타임라인 → 참가자별 스킬 순서 / 시작 아이템 / 구매 순서 */
const CONS = new Set([2003, 2010, 2031, 2033, 2055, 2138, 2139, 2140, 3340, 3363, 3364, 2052, 2422, 3330]);
function timelineOf(tl: any) {
  const out: Record<number, { skills: string; starter: number[]; buys: number[] }> = {};
  for (let i = 1; i <= 10; i++) out[i] = { skills: "", starter: [], buys: [] };
  for (const f of tl?.info?.frames || []) for (const e of f.events || []) {
    const o = out[e.participantId]; if (!o) continue;
    if (e.type === "SKILL_LEVEL_UP" && e.levelUpType === "NORMAL" && e.skillSlot >= 1 && e.skillSlot <= 4) { if (o.skills.length < 18) o.skills += "QWER"[e.skillSlot - 1]; }
    else if (e.type === "ITEM_PURCHASED") { if (e.timestamp < 60000) o.starter.push(e.itemId); if (!CONS.has(e.itemId)) o.buys.push(e.itemId); }
    else if (e.type === "ITEM_UNDO" && e.beforeId) { let k = o.buys.lastIndexOf(e.beforeId); if (k >= 0) o.buys.splice(k, 1); k = o.starter.lastIndexOf(e.beforeId); if (k >= 0 && e.timestamp < 75000) o.starter.splice(k, 1); }
  }
  for (const o of Object.values(out)) { o.buys = o.buys.slice(0, 40); o.starter = o.starter.slice(0, 6); }
  return out;
}
async function collectMatch(pf: string, m: any, tl?: any) {
  const id = m?.metadata?.matchId, info = m?.info;
  if (!id || !info) return;
  const dur = info.gameEndTimestamp ? info.gameDuration : info.gameDuration / 1000;
  if (!SR_Q.has(info.queueId) || dur < 300 || !Array.isArray(info.participants)) return;
  const patch = String(info.gameVersion || "").split(".").slice(0, 2).join(".");
  const end = new Date(info.gameEndTimestamp || (info.gameStartTimestamp || info.gameCreation) + dur * 1000).toISOString();
  const T = tl ? timelineOf(tl) : null;
  await sbInsert("owen_matches", [{ match_id: id, platform: pf, queue_id: info.queueId, patch, game_end: end, duration: Math.round(dur), enriched: !!T }], "match_id", true);
  await sbInsert("owen_champ_games", info.participants.filter((p: any) => p.puuid).map((p: any, i: number) => {
    const row: Record<string, unknown> = {
      match_id: id, puuid: p.puuid, champion_id: p.championId, position: p.teamPosition || "", win: !!p.win,
      kills: p.kills, deaths: p.deaths, assists: p.assists, cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
      damage: p.totalDamageDealtToChampions || 0, gold: p.goldEarned || 0, items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map((x: number) => x || 0),
      keystone: p.perks?.styles?.[0]?.selections?.[0]?.perk ?? null, spells: [p.summoner1Id, p.summoner2Id], queue_id: info.queueId, patch, game_end: end,
      platform: pf, riot_name: p.riotIdGameName || null, riot_tag: p.riotIdTagline || null, runes: runesOf(p),
    };
    if (T) { const t = T[p.participantId || i + 1]; row.skills = t?.skills || null; row.starter = t?.starter || null; row.buys = t?.buys || null; }
    return row;
  }), "match_id,puuid", true);
  const bans: unknown[] = []; for (const t of info.teams || []) for (const b of t.bans || []) if (b.championId > 0) bans.push({ match_id: id, team_id: t.teamId, champion_id: b.championId });
  await sbInsert("owen_bans", bans, "match_id,team_id,champion_id");
  if (!T) await sbInsert("owen_enrich_queue", [{ match_id: id, platform: pf }], "match_id");
}
/* 보강 작업: 대기열의 매치를 타임라인과 함께 다시 수집 (1분마다 pg_cron) */
async function enrich(key: string, n = 4) {
  const q = await fetch(`${SUPABASE_URL}/rest/v1/owen_enrich_queue?select=match_id,platform,tries&order=added_at.desc&limit=${n}`, { headers: svcH() }).then((r) => r.ok ? r.json() : []).catch(() => []);
  let done = 0, fail = 0;
  for (const it of q) {
    const pf = REGION[it.platform] ? it.platform : 'kr', base = `https://${REGION[pf]}.api.riotgames.com/lol/match/v5/matches/${it.match_id}`;
    try {
      const m = await riot(base, key, Infinity);
      const tl = await riot(base + "/timeline", key, 0, true);
      await collectMatch(pf, m, tl);
      await fetch(`${SUPABASE_URL}/rest/v1/owen_enrich_queue?match_id=eq.${it.match_id}`, { method: "DELETE", headers: svcH() });
      done++;
    } catch (e) {
      fail++;
      const st = (e as { status?: number }).status;
      if (st === 404 || st === 400 || (it.tries || 0) >= 3) await fetch(`${SUPABASE_URL}/rest/v1/owen_enrich_queue?match_id=eq.${it.match_id}`, { method: "DELETE", headers: svcH() });
      else await fetch(`${SUPABASE_URL}/rest/v1/owen_enrich_queue?match_id=eq.${it.match_id}`, { method: "PATCH", headers: { ...svcH(), Prefer: "return=minimal" }, body: JSON.stringify({ tries: (it.tries || 0) + 1 }) });
      if (st === 429) break;
    }
  }
  return { done, fail, picked: q.length };
}
async function collectMastery(pf: string, d: any) {
  const acc = d?.account; if (!acc?.puuid || !Array.isArray(d.mastery)) return;
  const solo = (d.league || []).find((e: any) => e.queueType === "RANKED_SOLO_5x5");
  await sbInsert("owen_mastery", d.mastery.map((m: any) => ({
    puuid: acc.puuid, champion_id: m.championId, points: m.championPoints, level: m.championLevel, platform: pf,
    riot_name: acc.gameName, riot_tag: acc.tagLine, solo_tier: solo?.tier ?? null, solo_rank: solo?.rank ?? null, solo_lp: solo?.leaguePoints ?? null, updated_at: new Date().toISOString(),
  })), "puuid,champion_id", true);
}
/* ---- 관전하기 스캐너: 1분마다(pg_cron) 상위 랭커 일부를 돌아가며 확인 → 찾은 게임은 끝날 때까지 owen_live에 보관 ---- */
const SCAN_TOKEN = Deno.env.get("SCAN_TOKEN") ?? "";
async function tierMap(pf: string, key: string) {
  const ck = 'tiermap:' + pf; const hit = cGet(ck); if (hit) return hit;
  const m: Record<string, { tier: string; lp: number }> = {};
  const lists = await Promise.all(['challengerleagues', 'grandmasterleagues', 'masterleagues'].map((t) => riot(`https://${pf}.api.riotgames.com/lol/league/v4/${t}/by-queue/RANKED_SOLO_5x5`, key, 900000).catch(() => null)));
  for (const l of lists) if (l) for (const e of l.entries || []) m[e.puuid] = { tier: l.tier, lp: e.leaguePoints };
  cSet(ck, m, 900000); return m;
}
const liveRows = (pf: string) => fetch(`${SUPABASE_URL}/rest/v1/owen_live?platform=eq.${pf}&select=game_id,data,updated_at`, { headers: svcH() }).then((r) => r.ok ? r.json() : []).catch(() => []);
const elapsedMs = (g: any, now: number, upd?: string) => g.gameStartTime > 0 ? now - g.gameStartTime : (g.gameLength || 0) * 1000 + (upd ? now - Date.parse(upd) : 0);
async function scanLive(pf: string, key: string, n = 18, rechecks = 5) {
  const tierOf = await tierMap(pf, key), now = Date.now();
  const cand = Object.entries(tierOf).sort((a, b) => (b[1].tier === 'CHALLENGER' ? 3e5 : b[1].tier === 'GRANDMASTER' ? 2e5 : 1e5) + b[1].lp - ((a[1].tier === 'CHALLENGER' ? 3e5 : a[1].tier === 'GRANDMASTER' ? 2e5 : 1e5) + a[1].lp)).slice(0, 1500).map((e) => e[0]);
  const active = (pu: string) => riot(`https://${pf}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${enc(pu)}`, key, 30000);
  const rows = await liveRows(pf);
  const gone: number[] = [], up: any[] = [], busy = new Set<string>();
  for (const r of rows) { if (elapsedMs(r.data, now, r.updated_at) > 65 * 60000) gone.push(r.game_id); else (r.data.participants || []).forEach((p: any) => busy.add(p.puuid)); }
  /* 오래된 게임부터 몇 개만 끝났는지 확인 (요청 수 절약) */
  const old = rows.filter((r: any) => !gone.includes(r.game_id) && elapsedMs(r.data, now, r.updated_at) > 18 * 60000).sort((a: any, b: any) => Date.parse(a.updated_at) - Date.parse(b.updated_at)).slice(0, rechecks);
  for (const r of old) {
    const pu = (r.data.participants || []).find((p: any) => p.puuid)?.puuid; if (!pu) { gone.push(r.game_id); continue; }
    try { const g = await active(pu); if (g?.gameId === r.game_id) up.push(g); else gone.push(r.game_id); }
    catch (e) { if ((e as { status?: number }).status === 404) gone.push(r.game_id); }
  }
  /* 새 게임 찾기: 분 단위로 다음 n명 (상태 저장 없이 순환) */
  const off = (Math.floor(now / 60000) * n) % Math.max(1, cand.length);
  const batch = [...cand.slice(off), ...cand.slice(0, off)].filter((pu) => !busy.has(pu)).slice(0, n);
  let i = 0, found = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < batch.length) {
      const pu = batch[i++]; if (busy.has(pu)) continue;
      try { const g = await active(pu); if (g?.gameId && g.gameMode !== 'TFT' && !rows.some((r: any) => r.game_id === g.gameId)) { up.push(g); found++; (g.participants || []).forEach((p: any) => busy.add(p.puuid)); } } catch { /* 게임 중 아님 */ }
    }
  }));
  if (gone.length) {
    const ended = rows.filter((r: any) => gone.includes(r.game_id) && [400, 420, 430, 440, 490].includes(r.data?.gameQueueConfigId)).map((r: any) => ({ match_id: `${String(r.data.platformId || pf).toUpperCase()}_${r.game_id}`, platform: pf }));
    if (ended.length) await sbInsert('owen_enrich_queue', ended, 'match_id');
    await fetch(`${SUPABASE_URL}/rest/v1/owen_live?game_id=in.(${gone.join(',')})`, { method: 'DELETE', headers: svcH() }).catch(() => {});
  }
  if (up.length) await sbInsert('owen_live', up.map((g) => ({ game_id: g.gameId, platform: pf, data: g, updated_at: new Date().toISOString() })), 'game_id', true);
  return { found, removed: gone.length, total: rows.length - gone.length + found, checked: batch.length };
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

  /* 관전하기 목록: 백그라운드 스캐너(scan)가 DB에 모아 둔 진행 중 게임을 바로 반환 */
  async spectate(q, key) {
    const pf = plat(q.platform || 'kr');
    const ck = 'speclist:' + pf; const hit = cGet(ck); if (hit) return hit;
    const tierOf = await tierMap(pf, key);
    let rows = await liveRows(pf);
    if (!rows.length) { await scanLive(pf, key, 16, 0); rows = await liveRows(pf); }
    const now = Date.now();
    const games = rows.map((r: any) => r.data).filter((g: any) => elapsedMs(g, now) < 65 * 60000);
    const score = (g: any) => (g.participants || []).reduce((s: number, p: any) => s + (tierOf[p.puuid] ? (tierOf[p.puuid].tier === 'CHALLENGER' ? 3 : tierOf[p.puuid].tier === 'GRANDMASTER' ? 2 : 1) + tierOf[p.puuid].lp / 2000 : 0), 0);
    const out = { platform: pf, updated: now, games: games.map((g: any) => ({ ...g, participants: (g.participants || []).map((p: any) => ({ ...p, tier: tierOf[p.puuid] || null })) })).sort((a: any, b: any) => score(b) - score(a)) };
    cSet(ck, out, 20000);
    return out;
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
    if (name === "enrich") {
      if (!SCAN_TOKEN || req.headers.get("x-scan-token") !== SCAN_TOKEN) return json(401, { error: "unauthorized" });
      return json(200, await enrich((await loadKey()).key, Math.min(20, Math.max(1, parseInt(u.searchParams.get("n") || "4")))));
    }
    if (name === "scan") {
      if (!SCAN_TOKEN || req.headers.get("x-scan-token") !== SCAN_TOKEN) return json(401, { error: "unauthorized" });
      const pf = plat(u.searchParams.get("platform") || "kr");
      const n = Math.min(60, Math.max(1, parseInt(u.searchParams.get("n") || "18")));
      return json(200, await scanLive(pf, (await loadKey()).key, n, Math.min(10, parseInt(u.searchParams.get("re") || "5"))));
    }
    const fn = (routes as Record<string, (q: Record<string, string>, key: string) => Promise<unknown>>)[name];
    if (!fn) return json(404, { error: "없는 API입니다." });
    const key = (req.headers.get("x-riot-key") || "").trim() || (await loadKey()).key;
    const out = await fn(Object.fromEntries(u.searchParams), key);
    if (name === "match") { const mid = (out as any)?.metadata?.matchId; if (mid && !collected.has(mid)) { collected.add(mid); if (collected.size > 20000) collected.clear(); bg(collectMatch(plat(u.searchParams.get("platform") || "kr"), out)); } }
    else if (name === "profile") bg(collectMastery((out as any).platform || plat(u.searchParams.get("platform") || "kr"), out));
    /* 끝난 매치는 바뀌지 않으므로 브라우저에 오래 캐시, 랭킹/로테이션은 짧게 */
    const cc = name === "match" || name === "account" ? "public, max-age=2592000, immutable" : name === "ranking" || name === "rotation" ? "public, max-age=120" : "no-store";
    return json(200, out, cc);
  } catch (e) {
    const st = (e as { status?: number }).status || 500;
    if (st === 401 || st === 403) vc = null;
    return json(st, { error: (e as Error).message || "서버 오류", code: st });
  }
});
