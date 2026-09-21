"use strict";
// Compares two versions of the download core (range-core + cdn-resolver + idm-downloader)
// on a simulated network. Usage:
//   node dev/download-benchmark.js <baselineDir> [currentDir] [scenarioPrefix[,prefix...]]
// Each directory must hold the three files; currentDir defaults to ../src. To compare with
// the last commit: git show HEAD:src/<file> > <baselineDir>/<file> for the three files.
//
// Segments are fetched the way native-mse-player does it: the first one alone, then a sliding
// window of three video segments (priorities 55/50/45) next to a window of four audio segments
// on the same downloader. Fetching one segment after another flatters a core that spreads a
// single segment well and hides how it behaves with several in flight.
//
// Two network models, because which one a viewer is on is not known:
//   pool - each node has one bandwidth pool that its active requests share, the way HTTP/2
//          carries every request to a host over one connection;
//   cap  - every request has its own speed limit (a throttled connection), the nodes have
//          plenty, and the viewer's line carries 100 Mbit/s in total.
// These are simulations. They show regressions and mechanisms, not what a real route gains.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const baselineDir = process.argv[2];
const currentDir = process.argv[3] || path.join(__dirname, "../src");
const filters = (process.argv[4] || "").split(",").filter(Boolean);
if (!baselineDir) {
  console.error("usage: node dev/download-benchmark.js <baselineDir> [currentDir] [scenarioPrefix]");
  process.exit(1);
}

function load(dir) {
  const context = vm.createContext({ URL, AbortController, DOMException, Response, ReadableStream, Headers, Uint8Array, Promise, Date, setTimeout, clearTimeout, performance, console });
  context.globalThis = context;
  for (const file of ["range-core.js", "cdn-resolver.js", "idm-downloader.js"]) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), "utf8"), context, { filename: `${dir}/${file}` });
  }
  return { cdn: context.__BILI_CDN_RESOLVER_FACTORY__, idm: context.__BILI_IDM_DOWNLOADER_FACTORY__ };
}

const HOSTS = [
  "upos-sz-mirrorali.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorbos.bilivideo.com",
  "upos-sz-mirror08c.bilivideo.com",
  "upos-sz-mirrorbd.bilivideo.com",
  "upos-sz-mirror14b.bilivideo.com",
  "upos-sz-estgoss.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com"
];
const mediaUrl = (host, file) => `https://${host}/upgcxcode/00/00/1/${file}.m4s?deadline=1&os=x`;
const MB = 1024 * 1024;
const KB = 1024;
const TOTAL_FILE = 512 * MB;
const TICK_MS = 20;

// profiles[host] = { latencyMs, bps: the node's pool, capBps: per request (optional),
// stallAfterRatio: a request to that node stops sending at that point and hangs }.
function makeNetwork(profiles, linkBps) {
  const stats = { requests: 0, bytesSent: 0, perHost: new Map(), busyTicks: 0, busyHosts: 0 };
  const pools = new Map();
  const timer = setInterval(() => {
    const wants = [];
    for (const [host, streams] of pools) {
      const flowing = [...streams].filter((stream) => stream.flowing());
      if (!flowing.length) continue;
      const profile = profiles[host];
      const share = Math.min(profile.bps * TICK_MS / 1000 / flowing.length, profile.capBps ? profile.capBps * TICK_MS / 1000 : Infinity);
      for (const stream of flowing) wants.push({ host, stream, size: share });
    }
    if (!wants.length) return;
    stats.busyTicks += 1;
    stats.busyHosts += new Set(wants.map((item) => item.host)).size;
    const total = wants.reduce((sum, item) => sum + item.size, 0);
    const scale = linkBps && total > linkBps * TICK_MS / 1000 ? (linkBps * TICK_MS / 1000) / total : 1;
    for (const item of wants) item.stream.deliver(Math.max(1, Math.floor(item.size * scale)));
  }, TICK_MS);
  const nativeFetch = async (url, init) => {
    const host = new URL(url).hostname;
    const profile = profiles[host];
    if (!profile) return new Response("", { status: 404 });
    const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const start = Number(startText), end = Number(endText);
    const length = end - start + 1;
    stats.requests += 1;
    stats.perHost.set(host, (stats.perHost.get(host) || 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, profile.latencyMs));
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const stallAt = profile.stallAfterRatio ? Math.floor(length * profile.stallAfterRatio) : Infinity;
    if (!pools.has(host)) pools.set(host, new Set());
    const pool = pools.get(host);
    const state = {
      sent: 0,
      controller: null,
      flowing() { return this.controller && this.sent < Math.min(length, stallAt); },
      deliver(share) {
        const size = Math.min(share, length - this.sent, stallAt - this.sent);
        if (size <= 0) return;
        try { this.controller.enqueue(new Uint8Array(size)); } catch (_error) { pool.delete(state); return; }
        this.sent += size;
        stats.bytesSent += size;
        if (this.sent >= length) {
          try { this.controller.close(); } catch (_error) {}
          pool.delete(state);
        }
      }
    };
    init.signal?.addEventListener("abort", () => { pool.delete(state); }, { once: true });
    const body = new ReadableStream({
      start(controller) {
        state.controller = controller;
        pool.add(state);
      },
      cancel() { pool.delete(state); }
    });
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${TOTAL_FILE}` } });
  };
  return { nativeFetch, stats, close: () => clearInterval(timer) };
}

// One track filled like native-mse-player's fillTrack: the first segment alone and written
// as it arrives, then a sliding window with the player's priorities.
async function fillTrack(downloader, resolver, track, segmentTimes) {
  const launch = (index, offset) => {
    const start = index * track.segmentBytes;
    const range = { start, end: start + track.segmentBytes - 1, length: track.segmentBytes };
    const startup = index === 0;
    const began = performance.now();
    return downloader.downloadRange(range, resolver, {
      parallel: true,
      kind: track.kind,
      startup,
      priority: startup ? 120 : Math.max(30, 55 - offset * 5),
      onOrderedChunk: startup ? async () => {} : null
    }).then((result) => {
      if ((result.byteLength || result.bytes?.length) !== range.length) throw new Error("segment length mismatch");
      if (track.kind === "video") segmentTimes.push(performance.now() - began);
    });
  };
  await launch(0, 0);
  const inflight = new Map();
  let next = 1;
  for (let head = 1; head < track.segments; head += 1) {
    while (next < track.segments && next < head + track.window) {
      inflight.set(next, launch(next, next - head));
      next += 1;
    }
    await inflight.get(head);
    inflight.delete(head);
  }
}

async function runScenario(build, scenario) {
  const network = makeNetwork(scenario.profiles, scenario.linkBps);
  const downloader = build.idm.createDownloader({ getSettings: () => ({ concurrency: scenario.concurrency, mode: "mainland" }), nativeFetch: network.nativeFetch });
  const bans = build.cdn.createBanList();
  const tracks = [
    { kind: "video", file: "1-1-30080", window: scenario.window || 3, segments: scenario.segments, segmentBytes: scenario.segmentBytes },
    ...(scenario.audio === false ? [] : [{ kind: "audio", file: "1-1-30280", window: 4, segments: scenario.segments, segmentBytes: 160 * KB }])
  ];
  const segmentTimes = [];
  const startedAt = performance.now();
  try {
    await Promise.all(tracks.map((track) => fillTrack(
      downloader,
      build.cdn.createResolver({ baseUrl: mediaUrl(HOSTS[0], track.file) }, () => "mainland", bans),
      track,
      segmentTimes
    )));
  } finally {
    network.close();
  }
  const wallMs = performance.now() - startedAt;
  const payload = tracks.reduce((sum, track) => sum + track.segments * track.segmentBytes, 0);
  return {
    wallMs: Math.round(wallMs),
    goodputMBps: (payload / MB) / (wallMs / 1000),
    wasteRatio: network.stats.bytesSent / payload - 1,
    requests: network.stats.requests,
    firstSegmentMs: Math.round(segmentTimes[0] || 0),
    maxSegmentMs: Math.round(Math.max(...segmentTimes)),
    busyHosts: network.stats.busyHosts / Math.max(1, network.stats.busyTicks),
    perHost: HOSTS.map((host) => network.stats.perHost.get(host) || 0).join("/")
  };
}

function profilesOf(speedsMB, latencyMs, extra = {}) {
  const profiles = {};
  HOSTS.forEach((host, index) => {
    profiles[host] = { latencyMs, bps: speedsMB[index % speedsMB.length] * MB, ...(extra.capBps ? { capBps: extra.capBps } : {}) };
    if (extra.stallHost === host) profiles[host].stallAfterRatio = 0.7;
  });
  return profiles;
}

const LINE = 12.5 * MB;
const SCENARIOS = {
  "pool-1 均匀 8×3MB/s RTT150 32线程": { profiles: profilesOf([3], 150), concurrency: 32, segments: 9, segmentBytes: 4 * MB },
  "pool-2 速度差异 0.5~8MB/s 32线程": { profiles: profilesOf([8, 6, 4, 3, 2, 1.5, 1, 0.5], 150), concurrency: 32, segments: 9, segmentBytes: 4 * MB },
  "pool-3 1节点中途停传 32线程": { profiles: profilesOf([3], 150, { stallHost: HOSTS[2] }), concurrency: 32, segments: 9, segmentBytes: 4 * MB },
  "pool-4 均匀 默认8线程": { profiles: profilesOf([3], 150), concurrency: 8, segments: 9, segmentBytes: 4 * MB },
  "pool-5 RTT400 4快4极慢 128线程": { profiles: profilesOf([4, 4, 4, 4, 0.05, 0.05, 0.05, 0.05], 400), concurrency: 128, segments: 7, segmentBytes: 4 * MB },
  "pool-6 均匀 逐段下载(旧基准的取法)": { profiles: profilesOf([3], 150), concurrency: 32, segments: 6, segmentBytes: 4 * MB, window: 1, audio: false },
  "cap-1 单请求150KB/s RTT200 32线程 1.5MB段": { profiles: profilesOf([40], 200, { capBps: 150 * KB }), linkBps: LINE, concurrency: 32, segments: 12, segmentBytes: 1.5 * MB },
  "cap-2 单请求400KB/s RTT200 32线程": { profiles: profilesOf([40], 200, { capBps: 400 * KB }), linkBps: LINE, concurrency: 32, segments: 9, segmentBytes: 4 * MB },
  "cap-3 单请求400KB/s 默认8线程": { profiles: profilesOf([40], 200, { capBps: 400 * KB }), linkBps: LINE, concurrency: 8, segments: 9, segmentBytes: 4 * MB },
  "cap-4 单请求400KB/s 1节点中途停传": { profiles: profilesOf([40], 200, { capBps: 400 * KB, stallHost: HOSTS[2] }), linkBps: LINE, concurrency: 32, segments: 9, segmentBytes: 4 * MB }
};

(async () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (filters.length && !filters.some((prefix) => name.startsWith(prefix))) continue;
    const results = {};
    for (const [label, dir] of [["baseline", baselineDir], ["current", currentDir]]) {
      const runs = [];
      for (let repeat = 0; repeat < 3; repeat += 1) runs.push(await runScenario(load(dir), scenario));
      runs.sort((a, b) => a.wallMs - b.wallMs);
      results[label] = runs[1]; // median of three
    }
    console.log(`\n=== ${name} ===`);
    for (const [label, run] of Object.entries(results)) {
      console.log(`${label.padEnd(8)} wall ${String(run.wallMs).padStart(6)} ms  goodput ${run.goodputMBps.toFixed(2).padStart(6)} MB/s  waste ${(run.wasteRatio * 100).toFixed(1).padStart(5)}%  requests ${String(run.requests).padStart(4)}  first segment ${String(run.firstSegmentMs).padStart(5)} ms  worst ${String(run.maxSegmentMs).padStart(5)} ms  busy nodes ${run.busyHosts.toFixed(1)}  per node ${run.perHost}`);
    }
    console.log(`speedup ×${(results.baseline.wallMs / results.current.wallMs).toFixed(2)}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
