// Runs the real native-mse-player.js against a fake MediaSource whose buffer runs out of
// quota, and against playinfo refreshes that renew the signed addresses of the same files.
(function installQuotaRefreshTest(root) {
  "use strict";

  const SEGMENT_SECONDS = 2;
  const SEGMENT_COUNT = 60;
  const video = document.querySelector("video");
  let clock = 0;
  let removals = [];
  let quotaThrows = 0;
  let buffers = [];
  // What the next fake buffers are made of; each scenario sets it before creating its player.
  let bufferSetup = null;

  Object.defineProperty(video, "currentTime", { configurable: true, get: () => clock, set(value) { clock = Number(value) || 0; } });
  // The viewer left the video paused; whatever the player does, it must not start it.
  let playCalls = 0;
  video.play = () => { playCalls += 1; return Promise.resolve(); };
  URL.createObjectURL = () => `${location.origin}/fake-media-source`;
  URL.revokeObjectURL = () => {};

  // quotaPlan: scripted answers, true = the append throws QuotaExceededError.
  // capacitySeconds: the buffer holds that much media, like a browser's byte quota.
  // evictsPlayed: before it refuses, it drops what lies behind the playhead on its own, the
  // way browsers do, so whatever is refused is refused because of the data ahead.
  class FakeSourceBuffer extends EventTarget {
    constructor(kind) {
      super();
      const setup = bufferSetup?.[kind] || {};
      this.kind = kind;
      this.updating = false;
      this.ranges = (setup.ranges || [[0, 34]]).map((range) => range.slice());
      this.quotaPlan = (setup.quotaPlan || []).slice();
      this.capacitySeconds = setup.capacitySeconds || Infinity;
      this.evictsPlayed = setup.evictsPlayed === true;
      this.appended = [];
      buffers.push(this);
    }

    get buffered() {
      const ranges = this.ranges;
      return { length: ranges.length, start: (index) => ranges[index][0], end: (index) => ranges[index][1] };
    }

    held() { return this.ranges.reduce((sum, [from, to]) => sum + to - from, 0); }

    drop(start, end) {
      this.ranges = this.ranges
        .map(([from, to]) => (to <= start || from >= end ? [from, to] : from >= start && to <= end ? null : from < start ? [from, start] : [end, to]))
        .filter(Boolean);
    }

    finish(change) {
      this.updating = true;
      setTimeout(() => {
        change();
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      }, 1);
    }

    appendBuffer(bytes) {
      if (this.updating) throw new DOMException("still updating", "InvalidStateError");
      // The fake downloader writes 1000 + the segment number into the first bytes of a media
      // segment; the initialization segment carries zeros and takes no room.
      const mark = bytes.byteLength >= 4 ? new DataView(bytes.buffer, bytes.byteOffset).getInt32(0) : 0;
      const media = mark >= 1000;
      let refuse = this.quotaPlan.length ? this.quotaPlan.shift() : false;
      if (!refuse && media && this.held() + SEGMENT_SECONDS > this.capacitySeconds) {
        if (this.evictsPlayed) this.drop(0, Math.max(0, clock - 1));
        refuse = this.held() + SEGMENT_SECONDS > this.capacitySeconds;
      }
      if (refuse) {
        quotaThrows += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      if (media) this.appended.push(mark - 1000);
      this.finish(() => {
        if (!media) return;
        const last = this.ranges.at(-1);
        if (last) last[1] += SEGMENT_SECONDS;
        else this.ranges.push([clock, clock + SEGMENT_SECONDS]);
      });
    }

    remove(start, end) {
      if (this.updating) throw new DOMException("still updating", "InvalidStateError");
      removals.push({ kind: this.kind, start, end });
      this.finish(() => this.drop(start, end));
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
  let downloadedUrls = [];
  let downloadDelayMs = 20;
  root.__BILI_IDM_DOWNLOADER_FACTORY__ = {
    createDownloader: () => ({
      async downloadRange(range, resolver, options) {
        const bytes = new Uint8Array(8);
        if (options.kind === "meta") return { bytes, pieceCount: 1, total: null, hosts: [] };
        new DataView(bytes.buffer).setInt32(0, 1000 + Math.round(range.start / 1000) - 1);
        options.onStartupScheduled?.();
        await new Promise((resolve) => setTimeout(resolve, downloadDelayMs));
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        downloadedUrls.push({ kind: options.kind, url: resolver.urls()[0] || "", segment: Math.round(range.start / 1000) - 1 });
        if (typeof options.onOrderedChunk === "function") {
          await options.onOrderedChunk(bytes, range, null);
          return { bytes: null, byteLength: range.length, pieceCount: 1, streamed: true, total: null, hosts: [] };
        }
        return { bytes, byteLength: range.length, pieceCount: 1, streamed: false, total: null, hosts: [] };
      }
    })
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (condition, ms) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline && !condition()) await sleep(25);
    return Boolean(condition());
  };
  const representation = (id, mimeType, codecs, bandwidth, deadline, file = id) => ({
    id, mimeType, codecs, bandwidth, height: 1080,
    baseUrl: `https://upos-sz-mirrorali.bilivideo.com/${file}.m4s?deadline=${deadline}&sig=${deadline}x`,
    segment_base: { initialization: "0-99", index_range: "100-999" }
  });
  const playinfoAt = (deadline, videoFile = 80) => ({ data: { dash: {
    duration: SEGMENT_COUNT * SEGMENT_SECONDS,
    video: [representation(80, "video/mp4", "avc1.640028", 2000000, deadline, videoFile)],
    audio: [representation(30280, "audio/mp4", "mp4a.40.2", 128000, deadline)]
  } } });

  function startPlayer(startAt, setup, errors, logs = []) {
    clock = startAt;
    playCalls = 0;
    removals = [];
    quotaThrows = 0;
    buffers = [];
    downloadedUrls = [];
    bufferSetup = setup;
    return root.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
      container: document.querySelector(".bpx-player-container"),
      playinfo: playinfoAt(1000),
      initialTime: startAt,
      initialResume: false,
      getSettings: () => ({ enabled: true, mode: "mainland", concurrency: 8 }),
      nativeFetch: () => Promise.reject(new Error("no network in this test")),
      onState() {},
      onLog(title) { logs.push(title); },
      onFatal(error) { errors.push(String(error?.message || error)); }
    });
  }
  const videoBuffer = () => buffers.find((buffer) => buffer.kind === "video");
  const consecutive = (list) => list.every((value, index) => index === 0 || value === list[index - 1] + 1);

  // The video buffer refuses two appends once each; freeing played data lets each retry in.
  async function scriptedQuota() {
    const errors = [];
    const player = startPlayer(30, { video: { quotaPlan: [true, false, true, false] } }, errors);
    await until(() => quotaThrows >= 2 && videoBuffer().appended.length >= 2, 8000);
    await sleep(200);
    const debug = player.getDebug();
    const appended = videoBuffer().appended.slice();
    player.destroy({ resumeNative: false });
    return {
      errors, quotaThrows, appends: appended.length, appended, removals: removals.slice(0, 4), bufferAheadLimit: debug.bufferAheadLimit,
      pass: !errors.length && quotaThrows === 2 && appended.length >= 2 && consecutive(appended)
        && removals.some((item) => item.kind === "video" && item.start === 0 && item.end > 0 && item.end <= 25.01)
        && debug.bufferAheadLimit >= 8 && debug.bufferAheadLimit <= 45
    };
  }

  // A buffer with a real capacity, the viewer has paused right after the start: nothing played
  // can be freed, so the retry is refused too. The segment must be kept, not retried or
  // downloaded again while the video stays paused, and written, once and in order, after the
  // viewer has played on. The player never starts the video by itself.
  async function fullBufferWaits() {
    const errors = [];
    const player = startPlayer(2, { video: { ranges: [[0, 34]], capacitySeconds: 40, evictsPlayed: true } }, errors);
    await until(() => quotaThrows >= 2, 8000);
    await sleep(300);
    const debugHeld = player.getDebug();
    const throwsWhenHeld = quotaThrows;
    const appendsWhenHeld = videoBuffer().appended.length;
    const downloadsWhenHeld = downloadedUrls.filter((item) => item.kind === "video").length;
    await sleep(1700); // two buffer checks pass; the playhead does not move
    const quiet = quotaThrows === throwsWhenHeld && videoBuffer().appended.length === appendsWhenHeld
      && downloadedUrls.filter((item) => item.kind === "video").length === downloadsWhenHeld;
    clock = 16; // playing on: the browser can now drop what was played
    video.dispatchEvent(new Event("timeupdate"));
    const resumed = await until(() => videoBuffer().appended.length >= appendsWhenHeld + 3, 6000);
    const appended = videoBuffer().appended.slice();
    const segments = downloadedUrls.filter((item) => item.kind === "video").map((item) => item.segment);
    player.destroy({ resumeNative: false });
    return {
      errors, throwsWhenHeld, appendsWhenHeld, quiet, resumed, appended: appended.slice(0, 12), bufferAheadLimit: debugHeld.bufferAheadLimit,
      playCalls,
      pass: !errors.length && throwsWhenHeld >= 2 && quiet && resumed && consecutive(appended) && playCalls === 0
        && new Set(segments).size === segments.length
        && debugHeld.bufferAheadLimit >= 8 && debugHeld.bufferAheadLimit < 40
    };
  }

  // Full with only a few seconds ahead and nothing to free: waiting would stall the video, so
  // this stays the failure it always was.
  async function fullBufferWithNothingAhead() {
    const errors = [];
    const player = startPlayer(30, { video: { ranges: [[26, 34]], capacitySeconds: 8 } }, errors);
    const failed = await until(() => errors.length > 0, 6000);
    const appends = videoBuffer()?.appended.length || 0;
    player.destroy({ resumeNative: false });
    return { errors, failed, appends, pass: failed && errors.length === 1 && appends === 0 };
  }

  // A kept segment belongs to its session: after a switch to another file nothing of the old
  // session reaches any buffer.
  async function heldSegmentDiesWithItsSession() {
    const errors = [];
    const player = startPlayer(2, { video: { ranges: [[0, 34]], capacitySeconds: 40, evictsPlayed: true } }, errors);
    await until(() => quotaThrows >= 2, 8000);
    await sleep(200);
    const oldBuffer = videoBuffer();
    const oldAppends = oldBuffer.appended.length;
    bufferSetup = { video: { ranges: [] }, audio: { ranges: [] } };
    await player.updatePlayinfo(playinfoAt(1000, "other-file"));
    const newBuffer = () => buffers.filter((buffer) => buffer.kind === "video").at(-1);
    const restarted = await until(() => newBuffer() !== oldBuffer && newBuffer().appended.length >= 2, 6000);
    const heldSegment = oldBuffer.appended.at(-1) + 1;
    await sleep(300);
    const fresh = newBuffer().appended.slice();
    player.destroy({ resumeNative: false });
    return {
      errors, restarted, oldAppends, oldAppendsAfter: oldBuffer.appended.length, heldSegment, fresh: fresh.slice(0, 6),
      pass: !errors.length && restarted && oldBuffer.appended.length === oldAppends && consecutive(fresh) && fresh[0] === 1
    };
  }

  // The quota brought the forward buffer down to its floor of eight seconds, then playback
  // stalls. A recovery that kept waiting for ten seconds would never end.
  async function recoveryUnderALoweredLimit() {
    const errors = [];
    const logs = [];
    // A slow first segment: the player then asks for the longest buffer, ten seconds, before
    // it resumes after a stall.
    downloadDelayMs = 2100;
    const player = startPlayer(0, { video: { ranges: [[0, 8.5]], capacitySeconds: 11, evictsPlayed: true } }, errors, logs);
    await until(() => videoBuffer()?.appended.length >= 1, 8000);
    downloadDelayMs = 20;
    await until(() => quotaThrows >= 2, 8000);
    await sleep(900);
    const limit = player.getDebug().bufferAheadLimit;
    clock = 2.3; // 8.2 seconds ahead: above the limit, so nothing more is written
    video.dispatchEvent(new Event("waiting"));
    const recovered = await until(() => logs.includes("缓冲补好了，可以继续播放"), 4000);
    player.destroy({ resumeNative: false });
    return { errors, limit, recovered, logs: logs.slice(-4), pass: !errors.length && limit === 8 && recovered };
  }

  // The other order: playback has stalled and waits for ten seconds of buffer, then the buffer
  // is full with less than that ahead. There is nothing to wait for, so this ends as a
  // failure at once instead of a video that waits for ever.
  async function aStallThatMeetsAFullBufferFails() {
    const errors = [];
    const logs = [];
    downloadDelayMs = 2100;
    const player = startPlayer(0, { video: { ranges: [[0, 6.2]], capacitySeconds: 9, evictsPlayed: true } }, errors, logs);
    await until(() => logs.includes("开播需要的缓冲已经够了"), 8000);
    downloadDelayMs = 400;
    video.dispatchEvent(new Event("waiting"));
    const failed = await until(() => errors.length > 0, 6000);
    player.destroy({ resumeNative: false });
    downloadDelayMs = 20;
    return { errors, failed, logs: logs.slice(-3), pass: failed && errors.length === 1 };
  }

  // An answer that arrives late must not put back addresses that expire sooner.
  async function olderAnswerKeepsNewerAddresses() {
    const errors = [];
    const player = startPlayer(30, {}, errors);
    await until(() => downloadedUrls.length >= 2, 6000);
    await player.updatePlayinfo(playinfoAt(3000));
    await player.updatePlayinfo(playinfoAt(2000));
    await sleep(80);
    const from = downloadedUrls.length;
    clock += 12;
    video.dispatchEvent(new Event("timeupdate"));
    await until(() => ["video", "audio"].every((kind) => downloadedUrls.slice(from).some((item) => item.kind === kind)), 5000);
    await sleep(100);
    const deadlines = [...new Set(downloadedUrls.slice(from).map((item) => Number(new URL(item.url).searchParams.get("deadline"))))];
    const reported = player.urlDeadlineSeconds();
    // A drag far outside the buffer moves both tracks to the new position inside the running
    // session. It must not pick the older addresses up again from the playinfo that was
    // turned away, and it must not rebuild the session (which would reset the element).
    const sessions = player.getDebug().sessionStarts;
    const afterSeek = downloadedUrls.length;
    bufferSetup = { video: { ranges: [] }, audio: { ranges: [] } };
    clock = 100;
    video.dispatchEvent(new Event("seeking"));
    const restarted = await until(() => ["video", "audio"].every((kind) => downloadedUrls.slice(afterSeek).some((item) => item.kind === kind)), 6000)
      && player.getDebug().sessionStarts === sessions;
    await sleep(200);
    const afterSeekDeadlines = [...new Set(downloadedUrls.slice(afterSeek).map((item) => Number(new URL(item.url).searchParams.get("deadline"))))];
    player.destroy({ resumeNative: false });
    return {
      errors, reported, deadlines, restarted, afterSeekDeadlines,
      pass: !errors.length && reported === 3000 && deadlines.length === 1 && deadlines[0] === 3000
        && restarted && afterSeekDeadlines.length === 1 && afterSeekDeadlines[0] === 3000
    };
  }

  // The late answer is older only for a quality that is not playing. It must not wait there
  // for the viewer to switch to that quality.
  async function olderAddressOfAnotherQuality() {
    const errors = [];
    const twoQualities = (deadline80, deadline64) => ({ data: { dash: {
      duration: SEGMENT_COUNT * SEGMENT_SECONDS,
      video: [representation(80, "video/mp4", "avc1.640028", 2000000, deadline80), { ...representation(64, "video/mp4", "avc1.640028", 1000000, deadline64), height: 720 }],
      audio: [representation(30280, "audio/mp4", "mp4a.40.2", 128000, deadline80)]
    } } });
    const player = startPlayer(30, {}, errors);
    await until(() => downloadedUrls.length >= 2, 6000);
    await player.updatePlayinfo(twoQualities(3000, 3000));
    await player.updatePlayinfo(twoQualities(3000, 2000));
    await sleep(80);
    const from = downloadedUrls.length;
    bufferSetup = { video: { ranges: [] }, audio: { ranges: [] } };
    await player.setQuality(64);
    const switched = await until(() => downloadedUrls.slice(from).some((item) => item.kind === "video" && item.url.includes("/64.m4s")), 6000);
    await sleep(200);
    const deadlines = [...new Set(downloadedUrls.slice(from).filter((item) => item.url.includes("/64.m4s")).map((item) => Number(new URL(item.url).searchParams.get("deadline"))))];
    player.destroy({ resumeNative: false });
    return { errors, switched, deadlines, pass: !errors.length && switched && deadlines.length === 1 && deadlines[0] === 3000 };
  }

  // Bilibili's page answers first, then the timed refresh runs twice. After every one of them
  // both tracks must download with the newest signature, without restarting the session.
  async function repeatedRefresh() {
    const errors = [];
    const player = startPlayer(30, {}, errors);
    await until(() => downloadedUrls.length >= 2, 6000);
    const sessions = player.getDebug().sessionStarts;
    const rounds = [];
    for (const deadline of [2000, 3000, 4000]) {
      await player.updatePlayinfo(playinfoAt(deadline));
      await sleep(80); // downloads that were already running report their address first
      const from = downloadedUrls.length;
      clock += 12;
      video.dispatchEvent(new Event("timeupdate"));
      await until(() => ["video", "audio"].every((kind) => downloadedUrls.slice(from).some((item) => item.kind === kind)), 5000);
      await sleep(100);
      const seen = downloadedUrls.slice(from);
      rounds.push({
        deadline,
        reported: player.urlDeadlineSeconds(),
        video: [...new Set(seen.filter((item) => item.kind === "video").map((item) => Number(new URL(item.url).searchParams.get("deadline"))))],
        audio: [...new Set(seen.filter((item) => item.kind === "audio").map((item) => Number(new URL(item.url).searchParams.get("deadline"))))]
      });
    }
    const sessionsKept = player.getDebug().sessionStarts === sessions;
    player.destroy({ resumeNative: false });
    return {
      errors, sessionsKept, rounds,
      pass: !errors.length && sessionsKept && rounds.every((round) => round.reported === round.deadline
        && round.video.length === 1 && round.video[0] === round.deadline
        && round.audio.length === 1 && round.audio[0] === round.deadline)
    };
  }

  root.__runQuotaRefreshTest = async function runQuotaRefreshTest() {
    const result = document.getElementById("quota-refresh-result");
    const output = {};
    for (const [name, scenario] of Object.entries({ scriptedQuota, fullBufferWaits, fullBufferWithNothingAhead, heldSegmentDiesWithItsSession, recoveryUnderALoweredLimit, aStallThatMeetsAFullBufferFails, repeatedRefresh, olderAnswerKeepsNewerAddresses, olderAddressOfAnotherQuality })) {
      try { output[name] = await scenario(); }
      catch (error) { output[name] = { pass: false, crashed: String(error?.stack || error) }; }
    }
    output.pass = Object.values(output).every((item) => item.pass === true);
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
    result.dataset.done = "true";
  };
})(globalThis);
