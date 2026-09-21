"use strict";
// Compares two versions of the download core (range-core + cdn-resolver + idm-downloader)
// on a simulated network. Usage:
//   node dev/download-benchmark.js <baselineDir> [currentDir]
// Each directory must hold the three files; currentDir defaults to ../src.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const baselineDir = process.argv[2];
const currentDir = process.argv[3] || path.join(__dirname, "../src");
if (!baselineDir) {
  console.error("usage: node dev/download-benchmark.js <baselineDir> [currentDir]");
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
const mediaUrl = (host) => `https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const MB = 1024 * 1024;
const TOTAL_FILE = 512 * MB;
const TICK_MS = 20;

// A network where each HOST has one bandwidth pool that its active requests share, the way
// HTTP/2 multiplexes every request to a host over one connection. Throughput therefore only
// grows by spreading over more hosts, not by opening more requests to the same one.
// stallAfterRatio: a request to that host stops sending at that point and hangs.
function makeNetwork(profiles) {
  const stats = { requests: 0, bytesSent: 0, perHost: new Map() };
  const pools = new Map(); // host -> Set of stream states
  const timer = setInterval(() => {
    for (const [host, streams] of pools) {
      const flowing = [...streams].filter((stream) => stream.flowing());
      if (!flowing.length) continue;
      const share = Math.max(1, Math.floor(profiles[host].bps * TICK_MS / 1000 / flowing.length));
      for (const stream of flowing) stream.deliver(share);
    }
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

async function runScenario(build, profiles, options) {
  const network = makeNetwork(profiles);
  const downloader = build.idm.createDownloader({ getSettings: () => ({ concurrency: options.concurrency, mode: "mainland" }), nativeFetch: network.nativeFetch });
  const bans = build.cdn.createBanList();
  const resolver = build.cdn.createResolver({ baseUrl: mediaUrl(HOSTS[0]) }, () => "mainland", bans);
  const segmentTimes = [];
  const startedAt = performance.now();
  try {
    for (let index = 0; index < options.segments; index += 1) {
      const start = index * options.segmentBytes;
      const range = { start, end: start + options.segmentBytes - 1, length: options.segmentBytes };
      const segmentStartedAt = performance.now();
      let received = 0;
      const result = await downloader.downloadRange(range, resolver, {
        parallel: true,
        kind: "video",
        startup: index === 0,
        onOrderedChunk: async (bytes) => { received += bytes.byteLength; }
      });
      if ((result.byteLength || result.bytes?.length) !== range.length) throw new Error("segment length mismatch");
      if (result.streamed && received !== range.length) throw new Error("ordered chunks incomplete");
      segmentTimes.push(performance.now() - segmentStartedAt);
    }
  } finally {
    network.close();
  }
  const wallMs = performance.now() - startedAt;
  const payload = options.segments * options.segmentBytes;
  return {
    wallMs: Math.round(wallMs),
    goodputMBps: (payload / MB) / (wallMs / 1000),
    wasteRatio: network.stats.bytesSent / payload - 1,
    requests: network.stats.requests,
    maxSegmentMs: Math.round(Math.max(...segmentTimes)),
    perHost: Object.fromEntries([...network.stats.perHost].map(([host, count]) => [host.split(".")[0].replace("upos-sz-", ""), count]))
  };
}

function speedProfiles(speeds, latencyMs, stallHost) {
  const profiles = {};
  HOSTS.forEach((host, index) => {
    profiles[host] = { latencyMs, bps: speeds[index % speeds.length] * MB };
    if (stallHost === host) profiles[host].stallAfterRatio = 0.7;
  });
  return profiles;
}

const SCENARIOS = {
  "均匀节点 8×3MB/s RTT150": () => runScenarioArgs(speedProfiles([3], 150), { concurrency: 32, segments: 6, segmentBytes: 4 * MB }),
  "速度差异 8节点 0.5~8MB/s": () => runScenarioArgs(speedProfiles([8, 6, 4, 3, 2, 1.5, 1, 0.5], 150), { concurrency: 32, segments: 6, segmentBytes: 4 * MB }),
  "1节点中途停传 其余3MB/s": () => runScenarioArgs(speedProfiles([3], 150, HOSTS[2]), { concurrency: 32, segments: 6, segmentBytes: 4 * MB }),
  "高RTT400 4快4极慢 128线程": () => runScenarioArgs(speedProfiles([4, 4, 4, 4, 0.05, 0.05, 0.05, 0.05], 400), { concurrency: 128, segments: 5, segmentBytes: 4 * MB })
};

let scenarioArgs = null;
function runScenarioArgs(profiles, options) { scenarioArgs = { profiles, options }; }

(async () => {
  const results = {};
  for (const [name, prepare] of Object.entries(SCENARIOS)) {
    prepare();
    const { profiles, options } = scenarioArgs;
    results[name] = {};
    for (const [label, dir] of [["baseline", baselineDir], ["current", currentDir]]) {
      const runs = [];
      for (let repeat = 0; repeat < 3; repeat += 1) {
        runs.push(await runScenario(load(dir), profiles, options));
      }
      runs.sort((a, b) => a.wallMs - b.wallMs);
      results[name][label] = runs[1]; // median of three
    }
    const base = results[name].baseline, next = results[name].current;
    console.log(`\n=== ${name} ===`);
    for (const [label, run] of [["baseline", base], ["current", next]]) {
      console.log(`${label.padEnd(8)} wall ${String(run.wallMs).padStart(6)} ms  goodput ${run.goodputMBps.toFixed(2).padStart(6)} MB/s  waste ${(run.wasteRatio * 100).toFixed(1).padStart(5)}%  requests ${String(run.requests).padStart(4)}  worst segment ${run.maxSegmentMs} ms`);
    }
    console.log(`speedup ×${(base.wallMs / next.wallMs).toFixed(2)}  hosts(current): ${JSON.stringify(next.perHost)}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
