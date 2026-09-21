// Runs the real live-hook.js against a mock live CDN: two official nodes (one slow, one
// fast), a P2P mcdn node and an smtcdns relay wrapper. Checks the P2P SDK mocks, URL
// rewrites, the segment cache, the hedge to the second node and the speculative prefetch.
(function installLiveHookTest(root) {
  "use strict";

  root.__BTR_TEST_ALLOW_LIVE__ = true;

  const ORIGIN = "d1--ov-gotcha207.bilivideo.com";
  const FAST = "d1--ov-gotcha208.bilivideo.com";
  const CN = "d1--cn-gotcha204.bilivideo.com";
  const SLOW_FIRST_BYTE_MS = { [ORIGIN]: 900, [FAST]: 30, [CN]: 60 };
  const DIR = "/live-bvc/123456/live_1234_5678/";
  const requests = [];
  let futureBorn = false;

  const segmentBytes = (name) => {
    const bytes = new Uint8Array(2048);
    for (let i = 0; i < name.length; i += 1) bytes[i] = name.charCodeAt(i);
    return bytes;
  };

  const playlist = (from) => [
    "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1",
    '#EXT-X-MAP:URI="h100.m4s"',
    ...Array.from({ length: 4 }, (_x, i) => [`#EXTINF:1.00,`, `${from + i}.m4s`]).flat(),
    ""
  ].join("\n");

  // The mock network. Each request to a host answers after that host's first-byte delay.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  root.fetch = async function mockNetwork(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname;
    requests.push({ host, path: url.pathname, range: init?.headers?.Range || new Headers(init?.headers || {}).get("range") || "" });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    await sleep(SLOW_FIRST_BYTE_MS[host] ?? 20);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (host.includes("mcdn.")) return new Response(new Uint8Array(8), { status: 200 });
    if (!url.pathname.startsWith(DIR)) return new Response("nf", { status: 404 });
    const name = url.pathname.slice(DIR.length);
    if (name.endsWith(".m3u8")) return new Response(playlist(201), { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    if (name === "205.m4s" && !futureBorn) { futureBorn = true; return new Response("nf", { status: 404 }); }
    const body = segmentBytes(name);
    return new Response(body, { status: 200, headers: { "Content-Type": "video/iso.segment", "Content-Length": String(body.byteLength) } });
  };

  const CHANNEL = "__BILI_RANGE_ACCELERATOR_V1__";
  const sendSettings = (payload) => root.postMessage({ channel: CHANNEL, type: "settings", payload }, "*");

  root.__runLiveHookTest = async function runLiveHookTest() {
    const result = document.getElementById("live-hook-result");
    const output = { checks: {} };
    try {
      const hooked = root.fetch; // live-hook replaced fetch when it installed
      sendSettings({ enabled: true, liveEnabled: true });
      await sleep(30);

      // P2P SDK mocks are in place.
      output.checks.p2pMocked = typeof root.PCDNLoader === "function" && typeof root.BPP2PSDK === "function" && typeof root.SeederSDK === "function";

      // The player fetches the playlist: passed through, observed, prefetch starts.
      const playlistUrl = `https://${ORIGIN}${DIR}index.m3u8?expires=9&sig=a`;
      const m3u8 = await hooked(playlistUrl);
      output.checks.playlistPassedThrough = m3u8.status === 200 && (await m3u8.text()).includes("#EXT-X-MAP");
      // Wait for prefetch (candidate probe + hedges) to settle.
      await sleep(1400);
      const prefetched = requests.filter((r) => /\/20[1-4]\.m4s$/.test(r.path) && !r.range);
      output.checks.prefetchedAnnounced = new Set(prefetched.map((r) => r.path.split("/").pop())).size >= 3;
      output.checks.probedCandidates = requests.some((r) => r.host === FAST && r.range === "bytes=0-2047")
        && requests.some((r) => r.host === CN && r.range === "bytes=0-2047");
      output.checks.mapPrefetched = requests.some((r) => r.path.endsWith("/h100.m4s"));

      // The slow origin forces the hedge: announced segments must also have been asked of a
      // faster node, and the served bytes are still correct.
      const hedged = requests.filter((r) => /\/20[1-4]\.m4s$/.test(r.path) && r.host !== ORIGIN && !r.range);
      output.checks.hedgedToFasterNode = hedged.length >= 1;

      // The player then requests an announced segment: served from cache, no new network.
      const before = requests.length;
      const segResponse = await hooked(`https://${ORIGIN}${DIR}202.m4s`);
      const segBody = new Uint8Array(await segResponse.arrayBuffer());
      output.checks.servedFromCache = requests.length === before;
      output.checks.servedCorrectBytes = segResponse.status === 200 && segBody.byteLength === 2048
        && String.fromCharCode(...segBody.slice(0, 7)) === "202.m4s";

      // The player polls the playlist again; everything announced is cached now, so the
      // speculative fetch tries the future segment 205.
      await hooked(playlistUrl).then((r) => r.text());
      await sleep(400);
      output.checks.speculativeTried = requests.some((r) => r.path.endsWith("/205.m4s"));

      // P2P URLs are rewritten to an official node; smtcdns wrappers unwrap.
      const beforeP2p = requests.length;
      await hooked(`https://xy1x2x3xy.mcdn.bilivideo.cn:4483${DIR}203.m4s`).catch(() => {});
      const p2pRequests = requests.slice(beforeP2p);
      output.checks.p2pRewritten = p2pRequests.every((r) => !r.host.includes("mcdn."));
      const beforeWrap = requests.length;
      const wrapped = await hooked(`https://cache.smtcdns.net/${ORIGIN}${DIR}204.m4s`);
      output.checks.unwrapServed = wrapped.status === 200 && requests.length === beforeWrap; // 204 was already cached
      // Non-live URLs pass through untouched.
      const other = await hooked(`https://${ORIGIN}/other/file.bin`);
      output.checks.otherPassedThrough = other.status === 404;

      // Debug surface and stats.
      const debug = root.__biliThreadRipperLiveDebug?.getContext();
      output.checks.debugContext = Boolean(debug && debug.cached >= 4 && debug.hosts.some((h) => h.host === FAST && h.state === "healthy"));

      // Switching the module off hands requests back to the page's own connection.
      sendSettings({ enabled: true, liveEnabled: false });
      await sleep(30);
      const beforeOff = requests.length;
      await hooked(`https://${ORIGIN}${DIR}201.m4s`);
      output.checks.disabledPassesThrough = requests.length === beforeOff + 1 && requests.at(-1).host === ORIGIN;

      output.pass = Object.values(output.checks).every(Boolean);
    } catch (error) {
      output.error = String(error?.stack || error);
      output.pass = false;
    }
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
})(globalThis);
