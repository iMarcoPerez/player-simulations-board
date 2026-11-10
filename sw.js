/* Player Simulations Board — static service worker.
 *
 * Plays the role of .space-build/worker.js on hosts with no server
 * (GitHub Pages): intercepts the app's POST actions RPC calls and
 * answers them from the static snapshot files under data/, with the
 * exact action -> file mapping the worker uses:
 *
 *   POST {action, args} -> data/<action>[_<sport>].json
 *   getPlayer           -> the player out of the getBoard_<sport> board
 *
 * Where a board had to be split for transport, the worker's single
 * payload is stitched back together here:
 *   - getBoard_<sport>: players' game logs live in
 *     data/logs_<sport>_index.json + data/logs_<sport>_<n>.json shards
 *     and are merged back into the board's players.
 *   - getTrends: the players array lives in
 *     data/getTrends_players_<n>.json shards (chunk list in
 *     data/getTrends_index.json, header fields in
 *     data/getTrends_meta.json) and is merged back into one payload.
 *
 * Where the artifact's server shapes a response out of stored payloads
 * (its actions.ts handlers), the same shaping is applied here over the
 * same stored data, so the client receives what the artifact serves:
 *   - getPlayer attaches the player's stored `extra` (propGrades =
 *     Model detail, injuries with with/without split dates, similar
 *     defenses, gameCtx, diag) from data/detail_<sport>_<n>.json —
 *     the app.db extra_json the artifact itself renders, never a
 *     substitute feed.
 *   - getGames splits each game's stored evidence into
 *     evAway / evHome / h2h / notes and fills projection/book defaults.
 *   - getGrades maps the stored grade meta to `summary`.
 *   - getModelLab returns { lab: <stored payload> }.
 *   - getPicks recomputes the model picks from the stored propGrades /
 *     logs / averages exactly as the server handler does (A+ PICK
 *     grades that still clear the live line), reads tennis match plays
 *     from the games' stored play markers, and maps the filed-picks
 *     payload to filedPicks / filedSlateLabel / filedNote /
 *     filedRevisionLabel.
 *   - refreshData answers with the artifact's guest-denied payload —
 *     the public board is a viewer, exactly like a shared-page guest
 *     in the real app; the client's follow-up re-fetch then picks up
 *     the freshest pushed snapshot (data loads are network-first).
 *
 * Data loads are network-first (a fresh push shows immediately) with a
 * Cache Storage fallback for offline. Bump VERSION to roll out a new
 * worker; it activates immediately (skipWaiting + clients.claim).
 *
 * Every RPC answer uses the RPC envelope the app's client unwraps:
 * { data: <payload> } on success, { error: <message> } on failure.
 */

const VERSION = "2026-11-10.2";
const DATA_CACHE = "psb-data-" + VERSION;
const STATIC_CACHE = "psb-static-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== DATA_CACHE && k !== STATIC_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/* ------------------------------------------------------------------ */
/* Data loading (network-first, cache fallback), memoized per worker   */
/* ------------------------------------------------------------------ */

const memo = new Map();

function dataURL(path) {
  return new URL(path, self.registration.scope).toString();
}

async function fetchJSON(path) {
  try {
    const resp = await fetch(dataURL(path), { cache: "no-cache" });
    if (resp.ok) {
      const copy = resp.clone();
      caches
        .open(DATA_CACHE)
        .then((c) => c.put(dataURL(path), copy))
        .catch(() => {});
      return await resp.json();
    }
    if (resp.status === 404) return null;
    throw new Error("HTTP " + resp.status);
  } catch (err) {
    const cached = await caches.match(dataURL(path));
    if (cached) {
      try {
        return await cached.json();
      } catch {
        return null;
      }
    }
    return null;
  }
}

function memoized(key, build) {
  if (!memo.has(key)) memo.set(key, build());
  return memo.get(key);
}

async function loadMetaSports() {
  return memoized("meta", async () => {
    const meta = await fetchJSON("data/getMeta.json");
    return meta && Array.isArray(meta.sports) ? meta.sports : [];
  });
}

async function metaFor(sport) {
  const sports = await loadMetaSports();
  return sports.find((s) => s.sport === sport) ?? null;
}

/* The complete board payload for a sport: the index copy with every
 * player's game logs stitched back in from the log shards. Sports
 * whose board was never sharded pass through unchanged. */
async function stitchedBoard(sport) {
  return memoized("board:" + sport, async () => {
    const board = await fetchJSON(`data/getBoard_${sport}.json`);
    if (!board) return null;
    const index = await fetchJSON(`data/logs_${sport}_index.json`);
    if (index) {
      const shardNums = [...new Set(Object.values(index))].sort(
        (a, b) => a - b,
      );
      const shards = await Promise.all(
        shardNums.map((n) => fetchJSON(`data/logs_${sport}_${n}.json`)),
      );
      const byPkey = {};
      for (const shard of shards) {
        if (shard) Object.assign(byPkey, shard);
      }
      for (const p of board.players || []) {
        p.logs = byPkey[p.pkey] ?? p.logs ?? [];
      }
    }
    // The artifact's board rows carry ucl90 / lg90 beside the splits.
    for (const p of board.players || []) {
      if (p.ucl90 === undefined) p.ucl90 = p.splits?.ucl90 ?? null;
      if (p.lg90 === undefined) p.lg90 = p.splits?.lg90 ?? null;
    }
    return board;
  });
}

/* Per-player detail records (models / injuries / hit-rate inputs and
 * the raw stored `extra`) for a sport, as a Map pkey -> record. */
async function detailMap(sport) {
  return memoized("detail:" + sport, async () => {
    const index = await fetchJSON(`data/detail_${sport}_index.json`);
    if (!index) return null;
    const shardNums = [...new Set(Object.values(index))].sort(
      (a, b) => a - b,
    );
    const shards = await Promise.all(
      shardNums.map((n) => fetchJSON(`data/detail_${sport}_${n}.json`)),
    );
    const map = new Map();
    for (const shard of shards) {
      if (!shard) continue;
      for (const [pkey, rec] of Object.entries(shard)) map.set(pkey, rec);
    }
    return map;
  });
}

const EXTRA_DEFAULTS = {
  projMin: null,
  note: null,
  nextOpp: null,
  similar: null,
  injuries: [],
  injuriesLabel: null,
  propGrades: null,
  gameCtx: null,
  diag: null,
};

/* The player's stored extra, in the artifact's shape: the detail
 * record's raw `extra` (app.db extra_json) over the server defaults;
 * falls back to the record's top-level hit-rate inputs when a record
 * predates raw-extra storage. */
async function extraFor(sport, pkey) {
  const details = await detailMap(sport);
  const rec = details?.get(pkey) ?? null;
  if (rec && rec.extra && typeof rec.extra === "object") {
    return { ...EXTRA_DEFAULTS, ...rec.extra };
  }
  if (rec) {
    return {
      ...EXTRA_DEFAULTS,
      projMin: rec.projMin ?? null,
      nextOpp: rec.nextOpp ?? null,
      similar: rec.similar ?? null,
    };
  }
  return { ...EXTRA_DEFAULTS };
}

/* The complete Trends payload: header fields + the players array
 * merged back from its transport shards. */
async function stitchedTrends() {
  return memoized("trends", async () => {
    const direct = await fetchJSON("data/getTrends.json");
    if (direct) return direct;
    const meta = await fetchJSON("data/getTrends_meta.json");
    const index = await fetchJSON("data/getTrends_index.json");
    if (!meta || !index) return null;
    const players = [];
    for (let n = 0; n < (index.shards ?? 0); n++) {
      const chunk = await fetchJSON(`data/getTrends_players_${n}.json`);
      if (Array.isArray(chunk)) players.push(...chunk);
    }
    return { ...meta, players };
  });
}

/* ------------------------------------------------------------------ */
/* Response shaping — ports of the artifact's actions.ts handlers      */
/* ------------------------------------------------------------------ */

const EMPTY_EV = {
  w5: 0, l5: 0, d5: 0, w10: 0, l10: 0, d10: 0,
  pf5: null, pa5: null, pf10: null, pa10: null,
  ats5w: 0, ats5l: 0, ats5p: 0, ats10w: 0, ats10l: 0, ats10p: 0,
  ou10o: 0, ou10u: 0, ou10p: 0, avgTotal10: null,
  off: null, def: null, pace: null,
  sotFor10: null, sotAg10: null, shotsFor10: null, shotsAg10: null,
  out: [],
};
const PROJ_DEFAULTS = {
  projAway: null, projHome: null, projTotal: null, winProbHome: null,
  fairMlHome: null, fairMlAway: null, fairSpreadHome: null,
  sotHome: null, sotAway: null, shotsHome: null, shotsAway: null,
  possHome: null, possAway: null,
};
const BOOK_DEFAULTS = { spreadHome: null, total: null, mlHome: null, mlAway: null };

async function shapeGames(sport, file) {
  const games = (file?.games ?? []).map((g) => {
    const ev = g.evidence ?? {};
    return {
      gkey: g.gkey,
      away: g.away,
      home: g.home,
      startsAt: g.startsAt ?? null,
      league: g.league ?? null,
      proj: { ...PROJ_DEFAULTS, ...(g.proj ?? {}) },
      book: { ...BOOK_DEFAULTS, ...(g.book ?? {}) },
      picks: Array.isArray(g.picks) ? g.picks : [],
      evAway: { ...EMPTY_EV, ...(ev.away ?? {}) },
      evHome: { ...EMPTY_EV, ...(ev.home ?? {}) },
      h2h: Array.isArray(ev.h2h) ? ev.h2h : [],
      notes: Array.isArray(ev.notes) ? ev.notes : [],
    };
  });
  return { meta: await metaFor(sport), games };
}

async function shapeGrades(sport, file) {
  const gm = file?.meta ?? null;
  const summary = gm
    ? {
        headline: gm.headline,
        bySource: Array.isArray(gm.bySource) ? gm.bySource : [],
        notes: Array.isArray(gm.notes) ? gm.notes : [],
        gradedAt: gm.gradedAt ?? null,
      }
    : null;
  const grades = (file?.grades ?? []).map((r) => ({
    pickDate: r.pickDate,
    source: r.source,
    sourceLabel: r.sourceLabel,
    label: r.label,
    player: r.player,
    team: r.team,
    market: r.market,
    side: r.side,
    lineText: r.lineText ?? null,
    projectionText: r.projectionText ?? null,
    actualText: r.actualText ?? null,
    result: r.result,
    note: r.note ?? null,
  }));
  return { meta: await metaFor(sport), summary, grades };
}

/* getPicks — a direct port of the server handler over the stored
 * snapshot data (board players + stored extras + filed payload). */
async function computePicks(sport) {
  const board = await stitchedBoard(sport);
  const details = await detailMap(sport);
  const players = board?.players ?? [];

  const extraOf = (p) => {
    const rec = details?.get(p.pkey) ?? null;
    if (rec && rec.extra && typeof rec.extra === "object") {
      return { ...EXTRA_DEFAULTS, ...rec.extra };
    }
    if (rec) {
      return {
        ...EXTRA_DEFAULTS,
        projMin: rec.projMin ?? null,
        nextOpp: rec.nextOpp ?? null,
        similar: rec.similar ?? null,
      };
    }
    return { ...EXTRA_DEFAULTS };
  };

  const parsed = players.map((p) => ({
    row: p,
    extra: extraOf(p),
    logs: Array.isArray(p.logs) ? p.logs : [],
    avgs: p.avgs ?? { season: {}, l10: {}, l5: {}, gpSeason: 0, gpL10: 0, gpL5: 0 },
    proj: p.proj ?? {},
    line: p.line ?? {},
  }));

  const teamOut = new Map();
  for (const p of parsed) {
    if (teamOut.has(p.row.team)) continue;
    const outs = (p.extra.injuries ?? [])
      .filter((i) => i.status === "Out")
      .map((i) => i.name);
    if (outs.length > 0) teamOut.set(p.row.team, outs);
  }

  const sameTeam = (a, b) => {
    const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return false;
    return na === nb || (na.length >= 3 && nb.length >= 3 && (na.startsWith(nb) || nb.startsWith(na)));
  };
  const avgOf = (gs, key) => {
    let sum = 0;
    let n = 0;
    for (const g of gs) {
      const v = g.stats[key];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return n > 0 ? Math.round((sum / n) * 100) / 100 : null;
  };
  const hitsIn = (gs, key, line, dir) => {
    let hits = 0;
    let n = 0;
    for (const g of gs) {
      const v = g.stats[key];
      if (v == null || !Number.isFinite(v)) continue;
      n++;
      if (dir === "OVER" ? v > line : v < line) hits++;
    }
    return { hits, n };
  };

  const BANNED = new Set(["stl", "blk", "stl_blk"]);
  const round2 = (v) => Math.round(v * 100) / 100;

  const picks = [];
  for (const p of parsed) {
    const grades = p.extra.propGrades;
    if (!grades) continue;
    for (const [stat, g] of Object.entries(grades)) {
      if (g.grade !== "A+ PICK") continue;
      if (BANNED.has(stat)) continue;
      const dir = g.lean === "OVER" || g.lean === "UNDER" ? g.lean : null;
      const proj = p.proj[stat] ?? null;
      const line = p.line[stat] ?? null;
      if (!dir || proj == null || line == null) continue;
      if (dir === "OVER" ? proj <= line : proj >= line) continue;

      const l10 = hitsIn(p.logs.slice(0, 10), stat, line, dir);
      const l5 = hitsIn(p.logs.slice(0, 5), stat, line, dir);

      const nextOpp = p.extra.nextOpp;
      const h2hGames = nextOpp ? p.logs.filter((lg) => sameTeam(lg.opp, nextOpp)) : [];
      const h2h =
        h2hGames.length > 0
          ? { n: h2hGames.length, avg: avgOf(h2hGames, stat), hits: hitsIn(h2hGames, stat, line, dir).hits }
          : null;

      let without = null;
      let bestDiff = 0.49;
      for (const inj of p.extra.injuries ?? []) {
        if (inj.status !== "Out") continue;
        if (inj.withGp < 3 || inj.withoutGp < 3) continue;
        const set = new Set(inj.splitDates);
        const wo = p.logs.filter((lg) => (inj.splitIsWithout ? set.has(lg.date) : !set.has(lg.date)));
        const w = p.logs.filter((lg) => !wo.includes(lg));
        const woAvg = avgOf(wo, stat);
        const wAvg = avgOf(w, stat);
        if (woAvg == null || wAvg == null) continue;
        const diff = Math.abs(woAvg - wAvg);
        if (diff > bestDiff) {
          bestDiff = diff;
          without = {
            name: inj.name,
            status: inj.status,
            withAvg: wAvg,
            withoutAvg: woAvg,
            withGp: inj.withGp,
            withoutGp: inj.withoutGp,
          };
        }
      }

      const gc = p.extra.gameCtx;
      picks.push({
        pkey: p.row.pkey,
        name: p.row.name,
        team: p.row.team,
        position: p.row.position ?? null,
        matchup: p.row.matchup ?? null,
        matchupAt: p.row.matchupAt ?? null,
        stat,
        direction: dir,
        proj: round2(proj),
        line,
        edge: round2(proj - line),
        models: { base: g.base, eff: g.eff, pool: g.pool, adj: g.adj },
        modelsOnSide: g.modelsOnSide,
        star: g.star,
        dvp: g.dvp,
        seasonAvg: p.avgs.season[stat] ?? null,
        l10Avg: p.avgs.l10[stat] ?? null,
        l5Avg: p.avgs.l5[stat] ?? null,
        l10Hits: l10.hits,
        l10N: l10.n,
        l5Hits: l5.hits,
        l5N: l5.n,
        projMin: p.extra.projMin,
        l10Min: p.avgs.l10["min"] ?? null,
        minTrendL5: p.extra.diag?.minTrendL5 ?? null,
        h2h,
        without,
        ownOut: (teamOut.get(p.row.team) ?? []).filter((n) => n !== p.row.name).slice(0, 4),
        oppOut: nextOpp
          ? (parsed.find((q) => sameTeam(q.row.team, nextOpp))?.extra.injuries ?? [])
              .filter((i) => i.status === "Out")
              .map((i) => i.name)
              .slice(0, 4)
          : [],
        gameCtx: gc
          ? {
              projTotal: gc.projTotal,
              ownPace: gc.ownPace,
              oppPace: gc.oppPace,
              oppDef: gc.oppDef,
              leagueDef: gc.leagueDef,
              leaguePace: gc.leaguePace,
            }
          : null,
      });
    }
  }

  picks.sort((a, b) => {
    const ea = Math.abs(a.edge) / Math.max(1, a.line);
    const eb = Math.abs(b.edge) / Math.max(1, b.line);
    if (eb !== ea) return eb - ea;
    if (a.star !== b.star) return a.star ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Tennis match plays ride on the games' stored play markers.
  const matchPlays = [];
  if (sport === "tennis") {
    const gamesFile = await fetchJSON("data/getGames_tennis.json");
    const pkeyByName = new Map(players.map((p) => [p.name, p.pkey]));
    for (const g of gamesFile?.games ?? []) {
      const play = g.evidence?.play;
      if (!play) continue;
      matchPlays.push({
        gkey: g.gkey,
        isPlay: play.isPlay,
        label: play.label,
        labelSource: play.labelSource ?? null,
        player: play.player,
        opponent: play.opponent,
        event: g.league ?? null,
        startsAt: g.startsAt ?? null,
        modelPct: play.modelPct ?? null,
        fairMl: play.fairMl ?? null,
        bookMl: play.bookMl ?? null,
        bookSource: play.bookSource ?? "Pinnacle",
        gapPts: play.gapPts ?? null,
        pkey: pkeyByName.get(play.player) ?? null,
      });
    }
    matchPlays.sort(
      (a, b) => Number(b.isPlay) - Number(a.isPlay) || (b.gapPts ?? 0) - (a.gapPts ?? 0),
    );
  }

  const filedFile = await fetchJSON(`data/getPicks_${sport}.json`);
  return {
    meta: await metaFor(sport),
    picks,
    matchPlays,
    filedPicks: filedFile?.picks ?? [],
    filedSlateLabel: filedFile?.slateLabel ?? null,
    filedNote: filedFile?.note ?? null,
    filedRevisionLabel: filedFile?.revisionLabel ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* RPC handling — the worker.js contract                               */
/* ------------------------------------------------------------------ */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* The app's RPC client speaks in envelopes: a success body is
 * { data: <payload> } (the client returns body.data) and a failure
 * body is { error: <message> } (the client throws on it). The real
 * server runtime wraps handler results exactly this way. */
function ok(payload) {
  return jsonResponse({ data: payload });
}
function fail(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

const REFRESH_DENIED = {
  ok: false,
  denied: true,
  message:
    "Refreshing runs the workspace pipelines and is owner-only — you're seeing the latest saved snapshot. Sign in as the owner to refresh.",
  sports: [],
  nflEngineTask: "not started — owner-only",
};

const EMPTY_TRENDS = {
  generatedAt: null,
  slateDate: null,
  sport: null,
  logsMaxDate: null,
  linesPullTs: null,
  injuriesFeedTs: null,
  players: [],
};

async function handleActions(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail(String(err?.message ?? err));
  }
  const action = body.action || "";
  const args = body.args || {};
  const sport = (args.sport || "").toLowerCase();

  try {
    // 1. Single player card lookup (against the stitched board).
    if (action === "getPlayer" && sport && args.pkey) {
      const board = await stitchedBoard(sport);
      if (board) {
        const found = (board.players || []).find((p) => p.pkey === args.pkey) || null;
        if (!found) return ok({ player: null });
        const extra = await extraFor(sport, args.pkey);
        const player = {
          ...found,
          ucl90: found.splits?.ucl90 ?? null,
          lg90: found.splits?.lg90 ?? null,
          moves: found.moves ?? {},
          injCount: extra.injuries.length,
          star: extra.propGrades
            ? Object.values(extra.propGrades).some((g) => g?.star === true)
            : false,
          avgs: found.avgs ?? { season: {}, l10: {}, l5: {}, gpSeason: 0, gpL10: 0, gpL5: 0 },
          splits: found.splits ?? null,
          extra,
          logs: Array.isArray(found.logs) ? found.logs : [],
        };
        return ok({ player });
      }
      // Board snapshot missing: fall through to the worker's file mapping.
    }

    // 2. Actions whose stored payload needs the artifact's shaping.
    if (action === "getBoard" && sport) {
      const board = await stitchedBoard(sport);
      if (board) return ok(board);
    } else if (action === "getGames" && sport) {
      const file = await fetchJSON(`data/getGames_${sport}.json`);
      if (file) return ok(await shapeGames(sport, file));
    } else if (action === "getGrades" && sport) {
      const file = await fetchJSON(`data/getGrades_${sport}.json`);
      if (file) return ok(await shapeGrades(sport, file));
    } else if (action === "getPicks" && sport) {
      return ok(await computePicks(sport));
    } else if (action === "getModelLab") {
      const file = sport ? await fetchJSON(`data/getModelLab_${sport}.json`) : null;
      return ok({ lab: file?.payload ?? null });
    } else if (action === "getMovements" && sport) {
      const file = await fetchJSON(`data/getMovements_${sport}.json`);
      return ok({
        asOf: file?.asOf ?? null,
        syncLabel: file?.syncLabel ?? null,
        rows: Array.isArray(file?.rows) ? file.rows : [],
        gameRows: Array.isArray(file?.gameRows) ? file.gameRows : [],
      });
    } else if (action === "getMovementFeed") {
      const file = await fetchJSON("data/getMovementFeed.json");
      if (file) return ok(file);
      return ok({ asOf: null, todayCount: 0, events: [] });
    } else if (action === "getTrends") {
      const trends = await stitchedTrends();
      return ok(trends ?? EMPTY_TRENDS);
    } else if (action === "refreshData") {
      // A public viewer is a guest: the artifact denies the refresh and
      // the client re-reads the stored snapshot — here, the freshest
      // pushed one, since every data load is network-first.
      return ok(REFRESH_DENIED);
    }

    // 3. The worker's generic mapping: data/<action>[_<sport>].json
    //    served verbatim (getMeta, the four prelims, anything else
    //    with a snapshot file), else the worker's 404 JSON.
    let fileKey = action;
    if (sport) fileKey += `_${sport}`;
    const data = await fetchJSON(`data/${fileKey}.json`);
    if (data !== null) return ok(data);
    return fail(`Snapshot ${fileKey}.json not found`, 404);
  } catch (err) {
    return fail(String(err?.message ?? err));
  }
}

/* ------------------------------------------------------------------ */
/* Fetch routing                                                       */
/* ------------------------------------------------------------------ */

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname.endsWith("/actions")) {
    event.respondWith(handleActions(request));
    return;
  }

  // Same-origin GETs (page, assets, direct data links): network-first
  // so a fresh push shows immediately, cache fallback when offline.
  // Cross-origin requests pass through untouched.
  if (request.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(request, { cache: "no-cache" });
          if (resp.ok) {
            const copy = resp.clone();
            caches
              .open(STATIC_CACHE)
              .then((c) => c.put(request, copy))
              .catch(() => {});
          }
          return resp;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw err;
        }
      })(),
    );
  }
});
