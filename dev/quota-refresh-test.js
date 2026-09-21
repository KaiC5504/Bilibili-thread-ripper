// Runs the real native-mse-player.js against a fake MediaSource whose buffer runs out of
// quota, and against a playinfo refresh that renews the signed addresses of the same files.
(function installQuotaRefreshTest(root) {
  "use strict";

  const SEGMENT_SECONDS = 2;
  const SEGMENT_COUNT = 40;
  const video = document.querySelector("video");
  const removals = [];
  let quotaThrows = 0;
  let clock = 30;
  let appends = 0;

  Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock, set(value) { clock = Number(value) || 0; } });
  URL.createObjectURL = () => `${location.origin}/fake-media-source`;
  URL.revokeObjectURL = () => {};

  class FakeSourceBuffer extends EventTarget {
    constructor(kind) {
      super();
      this.kind = kind;
      this.updating = false;
      this.ranges = [[0, 34]];
      // Two separate appends each hit the quota once; the retry after freeing succeeds.
      this.quotaPlan = kind === "video" ? [true, false, true, false] : [];
    }

    get buffered() {
      const ranges = this.ranges;
      return { length: ranges.length, start: (index) => ranges[index][0], end: (index) => ranges[index][1] };
    }

    finish(change) {
      this.updating = true;
      setTimeout(() => {
        change();
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      }, 1);
    }

    appendBuffer() {
      if (this.quotaPlan.shift()) {
        quotaThrows += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      appends += 1;
      this.finish(() => {
        const last = this.ranges.at(-1);
        if (last) last[1] += SEGMENT_SECONDS;
        else this.ranges.push([clock, clock + SEGMENT_SECONDS]);
      });
    }

    remove(start, end) {
      removals.push({ kind: this.kind, start, end });
      // Freeing behind the playhead makes the retried append succeed.
      this.finish(() => {
        this.ranges = this.ranges
          .map(([from, to]) => (to <= end && from >= start ? null : [from < end && from >= start ? end : from, to]))
          .filter(Boolean);
      });
    }
  }

  root.MediaSource = class FakeMediaSource extends EventTarget {
    static isTypeSupported() { return true; }

    constructor() {
      super();
      this.readyState = "closed";
      this.duration = NaN;
      setTimeout(() => {
        this.readyState = "open";
        this.dispatchEvent(new Event("sourceopen"));
      }, 0);
    }

    addSourceBuffer(type) { return new FakeSourceBuffer(type.startsWith("audio") ? "audio" : "video"); }
    endOfStream() { this.readyState = "ended"; }
  };

  root.__BILI_SIDX__ = {
    parseSidx: () => ({
      segments: Array.from({ length: SEGMENT_COUNT }, (_item, index) => ({
        index,
        start: 1000 + index * 1000,
        end: 1999 + index * 1000,
        length: 1000,
        startTime: index * SEGMENT_SECONDS,
        endTime: (index + 1) * SEGMENT_SECONDS,
        durationSeconds: SEGMENT_SECONDS
      }))
    }),
    segmentIndexAt: (segments, seconds) => Math.max(0, Math.min(segments.length - 1, Math.floor(seconds / SEGMENT_SECONDS)))
  };

  // The downloader hands back the resolver's current first address with each fake segment,
  // so the test can see which signature the downloads would use.
  const downloadedUrls = [];
  root.__BILI_IDM_DOWNLOADER_FACTORY__ = {
    createDownloader: () => ({
      async downloadRange(range, resolver, options) {
        const bytes = new Uint8Array(8);
        if (options.kind === "meta") return { bytes, pieceCount: 1, total: null, hosts: [] };
        options.onStartupScheduled?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        downloadedUrls.push({ kind: options.kind, url: resolver.urls()[0] || "" });
        return { bytes, byteLength: range.length, pieceCount: 1, streamed: false, total: null, hosts: [] };
      }
    })
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const representation = (id, mimeType, codecs, bandwidth, deadline) => ({
    id, mimeType, codecs, bandwidth, height: 1080,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${id}.m4s?deadline=${deadline}&sig=${deadline}x`,
    segment_base: { initialization: "0-99", index_range: "100-999" }
  });
  const playinfoAt = (deadline) => ({ data: { dash: {
    duration: SEGMENT_COUNT * SEGMENT_SECONDS,
    video: [representation(80, "video/mp4", "avc1.640028", 2000000, deadline)],
    audio: [representation(30280, "audio/mp4", "mp4a.40.2", 128000, deadline)]
  } } });

  root.__runQuotaRefreshTest = async function runQuotaRefreshTest() {
    const result = document.getElementById("quota-refresh-result");
    const errors = [];
    const player = root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
      container: document.querySelector(".bpx-player-container"),
      playinfo: playinfoAt(1000),
      initialTime: 30,
      initialResume: false,
      getSettings: () => ({ enabled: true, mode: "mainland", concurrency: 8 }),
      nativeFetch: () => Promise.reject(new Error("no network in this test")),
      onState() {},
      onFatal(error) { errors.push(String(error?.message || error)); }
    });

    // The video buffer throws QuotaExceededError twice. Both appends must recover by
    // freeing played data instead of failing the takeover.
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline && quotaThrows < 2) await sleep(25);
    await sleep(400);
    const debug = player.getDebug();
    const output = { errors, quotaThrows, appends, removals: removals.slice(0, 4), bufferAheadLimit: debug.bufferAheadLimit };
    output.recovered = !errors.length && quotaThrows === 2 && appends > 4;
    output.freedBehind = removals.some((item) => item.kind === "video" && item.start === 0 && item.end > 0 && item.end <= clock - 5 + 0.01);
    output.limitLowered = debug.bufferAheadLimit >= 15 && debug.bufferAheadLimit <= 45;

    // The refreshed playinfo names the same file with a fresh signature: no session restart,
    // but the resolvers must start using the new address.
    output.deadlineBefore = player.urlDeadlineSeconds();
    const sessionsBefore = player.getDebug().sessionStarts;
    const urlCountBefore = downloadedUrls.length;
    await player.updatePlayinfo(playinfoAt(2000));
    clock += 10; // move the playhead so the filler asks for more segments
    video.dispatchEvent(new Event("timeupdate"));
    const refreshDeadline = performance.now() + 4000;
    while (performance.now() < refreshDeadline && downloadedUrls.length === urlCountBefore) await sleep(25);
    await sleep(100);
    output.deadlineAfter = player.urlDeadlineSeconds();
    output.sessionsKept = player.getDebug().sessionStarts === sessionsBefore;
    output.freshSignature = downloadedUrls.slice(urlCountBefore).some((item) => item.url.includes("deadline=2000"));
    output.staleSignature = downloadedUrls.slice(urlCountBefore).some((item) => item.url.includes("deadline=1000"));
    player.destroy({ resumeNative: false });

    output.pass = output.recovered && output.freedBehind && output.limitLowered
      && output.deadlineBefore === 1000 && output.deadlineAfter === 2000
      && output.sessionsKept && output.freshSignature && !output.staleSignature;
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
})(globalThis);
