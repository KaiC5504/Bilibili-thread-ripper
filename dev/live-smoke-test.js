"use strict";
// Live smoke test against a real Bilibili live room (needs network access; not part of the
// default regression run). Plays the fMP4 HLS stream for ~15 seconds twice:
//   baseline — the way the page player does it: poll the playlist on the assigned node and
//              download each segment from that node when it is announced;
//   ripper   — the live module's strategy: host pool with probing, hedged downloads and
//              prefetch of announced segments.
// Reports per-segment readiness delay (how long the player would wait for the segment).
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const context = vm.createContext({ URL, Date, console });
context.globalThis = context;
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/live-core.js"), "utf8"), context, { filename: "live-core.js" });
const live = context.__BILI_LIVE_CORE__;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com"
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchJson = (url) => fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) }).then((r) => r.json());
const swapHost = (url, host) => { const u = new URL(url); u.hostname = host; u.port = ""; return u.href; };

async function pullSegment(url, timeoutMs = 8000) {
  const startedAt = performance.now();
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200 && response.status !== 206) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("empty");
  return { bytes, ms: performance.now() - startedAt };
}

async function findStream() {
  const rooms = (await fetchJson("https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=8")).data || [];
  for (const room of rooms) {
    const payload = await fetchJson(`https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${room.roomid}&protocol=1&format=2&codec=0&qn=10000&platform=web&ptype=8`);
    const fmp4 = live.parseRoomPlayInfo(payload).find((s) => s.format === "fmp4");
    if (fmp4) return { room, playlistUrl: `${fmp4.urls[0].host}${fmp4.baseUrl}${fmp4.urls[0].extra}`, qn: fmp4.qn };
  }
  throw new Error("no live fmp4 stream found");
}

// Simulated playback: every new announced segment must be delivered; readiness delay is
// the wait between "the player wants it" (when announced) and "bytes in hand".
const fetchPlaylist = async (playlistUrl) => {
  try { return await fetch(playlistUrl, { headers: HEADERS, signal: AbortSignal.timeout(6000) }).then((r) => r.text()); }
  catch (_error) { return ""; }
};

async function playBaseline(playlistUrl, seconds) {
  const delays = [];
  const seen = new Set();
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    const text = await fetchPlaylist(playlistUrl);
    const { segments } = live.parseM3u8(text, playlistUrl);
    // A real player keeps a small buffer, so it asks for a segment about one position
    // behind the live edge — the same consumption point in both runs.
    const fresh = segments.slice(0, -1).filter((s) => !seen.has(s.name)).slice(-2);
    for (const segment of fresh) {
      seen.add(segment.name);
      try {
        const { ms } = await pullSegment(segment.url);
        delays.push(ms);
      } catch (error) { delays.push(8000); }
    }
    await sleep(500);
  }
  return delays;
}

async function playRipper(playlistUrl, seconds) {
  const pool = live.createHostPool({});
  const origin = new URL(playlistUrl).hostname;
  pool.add(origin, true);
  for (const host of live.KNOWN_FMP4_HOSTS) if (host !== origin) pool.add(host, false);
  const cache = new Map(); // url -> promise of {bytes, ms}
  let probed = false;

  const download = async (url) => {
    const hosts = pool.pick(2);
    const controllers = hosts.map(() => new AbortController());
    let primaryFailed = () => {};
    const primaryFailure = new Promise((resolve) => { primaryFailed = resolve; });
    const attempts = hosts.map((host, index) => (async () => {
      if (index) await new Promise((resolve) => { const t = setTimeout(resolve, 400); primaryFailure.then(() => { clearTimeout(t); resolve(); }); });
      const startedAt = performance.now();
      try {
        const response = await fetch(swapHost(url, host), { headers: HEADERS, signal: controllers[index].signal });
        if (response.status !== 200) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.byteLength) throw new Error("empty");
        const ms = performance.now() - startedAt;
        pool.success(host, ms, bytes.byteLength * 1000 / ms);
        return { bytes, host };
      } catch (error) {
        if (error?.name !== "AbortError" && Number(error?.status) !== 404) pool.failure(host, 0);
        if (!index) primaryFailed();
        throw error;
      }
    })());
    const timer = setTimeout(() => controllers.forEach((c) => c.abort(new Error("cap"))), 8000);
    try { return await Promise.any(attempts); }
    finally { clearTimeout(timer); controllers.forEach((c) => { if (!c.signal.aborted) c.abort(new Error("done")); }); }
  };
  const prefetch = (url) => { if (!cache.has(url)) { const p = download(url); p.catch(() => cache.delete(url)); cache.set(url, p); } return cache.get(url); };

  const delays = [];
  const seen = new Set();
  const hostsUsed = new Map();
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    const text = await fetchPlaylist(playlistUrl);
    const parsed = live.parseM3u8(text, playlistUrl);
    if (!parsed.segments.length) { await sleep(500); continue; }
    if (!probed) {
      probed = true;
      await Promise.allSettled(pool.unproven().map(async (host) => {
        const startedAt = performance.now();
        try {
          const r = await fetch(swapHost(parsed.segments[0].url, host), { headers: { ...HEADERS, Range: "bytes=0-2047" }, signal: AbortSignal.timeout(4000) });
          const b = new Uint8Array(await r.arrayBuffer());
          if ((r.status === 206 || r.status === 200) && b.byteLength) pool.success(host, performance.now() - startedAt, 0);
          else pool.failure(host, b.byteLength);
        } catch (_e) { pool.failure(host, 0); }
      }));
    }
    // prefetch everything announced; speculative next
    for (const segment of parsed.segments.slice(-4)) prefetch(segment.url);
    const last = parsed.segments.at(-1);
    if (last) prefetch(last.url.replace(`${last.num}.m4s`, `${last.num + 1}.m4s`));
    // the "player" consumes fresh segments one position behind the live edge
    const fresh = parsed.segments.slice(0, -1).filter((s) => !seen.has(s.name)).slice(-2);
    for (const segment of fresh) {
      seen.add(segment.name);
      const wantedAt = performance.now();
      try {
        const { host } = await prefetch(segment.url);
        delays.push(performance.now() - wantedAt);
        hostsUsed.set(host, (hostsUsed.get(host) || 0) + 1);
      } catch (_e) { delays.push(8000); }
    }
    await sleep(500);
  }
  return { delays, hostsUsed: Object.fromEntries(hostsUsed), poolStatus: pool.status() };
}

const stat = (values) => {
  if (!values.length) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return `n=${values.length} avg=${Math.round(avg)}ms p50=${Math.round(sorted[Math.floor(sorted.length / 2)])}ms max=${Math.round(sorted.at(-1))}ms`;
};

(async () => {
  const { room, playlistUrl, qn } = await findStream();
  console.log(`room ${room.roomid} (${String(room.title).slice(0, 24)}) qn=${qn} origin=${new URL(playlistUrl).hostname}`);
  const seconds = Number(process.env.BTR_LIVE_SMOKE_SECONDS) || 15;
  console.log(`\n-- baseline: single assigned node, download when announced (${seconds}s) --`);
  const baseline = await playBaseline(playlistUrl, seconds);
  console.log("segment readiness:", stat(baseline));
  console.log(`\n-- ripper: pool + probe + hedge + prefetch (${seconds}s) --`);
  const ripper = await playRipper(playlistUrl, seconds);
  console.log("segment readiness:", stat(ripper.delays));
  console.log("hosts used:", JSON.stringify(ripper.hostsUsed));
  console.log("pool:", ripper.poolStatus.map((s) => `${s.host.split(".")[0]}=${s.state}`).join(" "));
  const hit = ripper.delays.filter((d) => d < 50).length;
  console.log(`prefetch hits (<50ms): ${hit}/${ripper.delays.length}`);
})().catch((error) => { console.error("fatal", error); process.exitCode = 1; });
