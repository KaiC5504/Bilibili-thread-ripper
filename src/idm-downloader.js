(function installIdmDownloader(root) {
  "use strict";

  const core = root.__BILI_RANGE_CORE__;
  if (!core) return;

  const PIECE_ROUNDS = 3;
  const PIECE_RETRY_WINDOW_MS = 25000;
  // Below this a resumed request saves less than its own round trip costs.
  const RESUME_MIN_BYTES = 32 * 1024;

  function abortError(reason) {
    if (reason instanceof Error || reason instanceof DOMException) return reason;
    return new DOMException("播放器任务已取消", "AbortError");
  }

  class Semaphore {
    constructor(limit) {
      this.limit = limit;
      this.active = 0;
      this.queue = [];
      this.sequence = 0;
    }

    setLimit(limit) {
      this.limit = Math.max(1, Math.min(512, Math.trunc(limit) || 1));
      this.drain();
    }

    drain() {
      while (this.active < this.limit && this.queue.length) {
        const entry = this.queue.shift();
        entry.signal?.removeEventListener("abort", entry.cancel);
        if (entry.signal?.aborted) {
          entry.reject(abortError(entry.signal.reason));
          continue;
        }
        this.active += 1;
        entry.resolve(() => {
          if (entry.released) return;
          entry.released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        });
      }
    }

    acquire(signal, priority = 0) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise((resolve, reject) => {
        const entry = {
          reject,
          resolve,
          signal,
          released: false,
          priority: Number(priority) || 0,
          sequence: this.sequence++
        };
        entry.cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          reject(abortError(signal.reason));
        };
        signal?.addEventListener("abort", entry.cancel, { once: true });
        this.queue.push(entry);
        this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        this.drain();
      });
    }
  }

  function createDownloader(options) {
    const nativeFetch = options.nativeFetch || root.fetch.bind(root);
    const getSettings = options.getSettings;
    const onTransfer = typeof options.onTransfer === "function" ? options.onTransfer : () => null;
    // The page replaces its settings object when something changes, so the reference
    // tells whether the previous normalization is still valid.
    let rawSettings = null;
    let normalizedSettings = null;
    function config() {
      const raw = getSettings();
      if (raw !== rawSettings || !normalizedSettings) {
        rawSettings = raw;
        normalizedSettings = core.normalizeSettings(raw);
      }
      return normalizedSettings;
    }
    const semaphore = new Semaphore(config().concurrency);

    // What one connection typically delivers here and how long a sub-chunk typically
    // takes. Sub-chunk sizing and the hedge delay follow these measurements.
    const meter = { connectionBps: 0, pieceMs: 0 };
    function recordMeter(bytes, elapsedMs) {
      if (bytes < 48 * 1024 || elapsedMs <= 0) return;
      const bps = bytes * 1000 / elapsedMs;
      meter.connectionBps = meter.connectionBps ? meter.connectionBps * 0.7 + bps * 0.3 : bps;
      meter.pieceMs = meter.pieceMs ? meter.pieceMs * 0.7 + elapsedMs * 0.3 : elapsedMs;
    }

    // A sub-chunk should keep its connection busy for a good part of a second, otherwise
    // request round trips dominate on high-latency routes. 64 KiB stays the floor while
    // the speed is still unknown, and a range still splits into at least one piece per
    // node: the total bandwidth only grows by spreading over hosts, and the hedges
    // against a stalling one need more than a single request to work with.
    function adaptiveMinChunk(settings, rangeLength, pieceLimit, hostCount = 4) {
      if (!meter.connectionBps) return settings.minChunkBytes;
      const target = Math.floor(meter.connectionBps * 0.6 / (64 * 1024)) * 64 * 1024;
      const spread = Math.ceil(rangeLength / Math.max(1, Math.min(Math.max(4, hostCount), pieceLimit)));
      return Math.max(settings.minChunkBytes, Math.min(1024 * 1024, target, spread));
    }

    // A second copy starts once a piece takes clearly longer than pieces have been
    // taking, instead of always waiting the full fixed delay.
    function hedgeDelayMs(settings) {
      if (!meter.pieceMs) return settings.hedgeDelayMs;
      return Math.max(250, Math.min(settings.hedgeDelayMs, Math.round(meter.pieceMs * 1.5)));
    }

    async function readBody(response, controller, transferId, settings, received) {
      if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        received.bytes += bytes.byteLength;
        received.chunks?.push(bytes);
        onTransfer({ phase: "progress", id: transferId, bytes: bytes.byteLength });
        return bytes;
      }
      const reader = response.body.getReader();
      // Do not rely on fetch implementations to unblock read() after abort. A
      // pending reader must release its concurrency slot before a quality change.
      const cancelReader = () => { reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const chunks = [];
      let total = 0;
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块停止传输", "TimeoutError")), settings.stallTimeoutMs);
      };
      armStall();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          if (done) break;
          armStall();
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          chunks.push(chunk);
          total += chunk.byteLength;
          received.bytes += chunk.byteLength;
          // The recorder keeps what a failed attempt already received, so a retry or a
          // hedge copy can ask only for the missing tail.
          received.chunks?.push(chunk);
          onTransfer({ phase: "progress", id: transferId, bytes: chunk.byteLength });
        }
      } finally {
        clearTimeout(stallTimer);
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock?.();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }

    async function attempt(piece, url, signal, kind, resolver, priority = 0, received = { bytes: 0, chunks: [] }) {
      const settings = config();
      const release = await semaphore.acquire(signal, priority);
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(signal?.reason));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      const firstByteTimer = setTimeout(() => controller.abort(new DOMException("CDN 首字节超时", "TimeoutError")), settings.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => controller.abort(new DOMException("CDN 子块总耗时超限", "TimeoutError")), settings.attemptTimeoutMs);
      const transferId = onTransfer({ phase: "start", kind, totalBytes: piece.length, url });
      const startedAt = performance.now();
      try {
        const response = await nativeFetch(url, {
          method: "GET",
          headers: { Range: `bytes=${piece.start}-${piece.end}` },
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          referrer: root.location?.href,
          referrerPolicy: "strict-origin-when-cross-origin",
          priority: priority >= 100 ? "high" : "auto",
          signal: controller.signal
        });
        clearTimeout(firstByteTimer);
        const contentRange = core.parseContentRange(response.headers.get("content-range"));
        if (response.status !== 206 || !contentRange || contentRange.start !== piece.start || contentRange.end !== piece.end) {
          // The status tells a refused signed address (4xx) apart from a node that is down.
          throw Object.assign(new Error(`Range 校验失败：HTTP ${response.status}`), { status: response.status });
        }
        const bytes = await readBody(response, controller, transferId, settings, received);
        if (bytes.byteLength !== piece.length) throw new Error(`子块长度不符：${bytes.byteLength}/${piece.length}`);
        const elapsedMs = Math.max(1, performance.now() - startedAt);
        recordMeter(bytes.byteLength, elapsedMs);
        resolver.success(url, bytes.byteLength * 1000 / elapsedMs);
        onTransfer({ phase: "done", id: transferId });
        return { bytes, total: contentRange.total, url };
      } catch (error) {
        // Received bytes tell a dead node (0 KiB) apart from a transfer that stalled midway.
        resolver.failure(url, error, received.bytes);
        const canceled = error?.name === "AbortError";
        onTransfer({ phase: canceled ? "cancel" : "error", id: transferId, error });
        throw error;
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        // Invalid headers can reject before readBody obtains a reader. Stop that
        // response too, otherwise it keeps downloading after releasing the slot.
        controller.abort();
        signal?.removeEventListener("abort", cancel);
        release();
      }
    }

    function pause(delayMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        function done() {
          signal?.removeEventListener("abort", canceled);
          resolve();
        }
        function canceled() {
          clearTimeout(timer);
          reject(abortError(signal.reason));
        }
        if (signal?.aborted) canceled();
        else signal?.addEventListener("abort", canceled, { once: true });
      });
    }

    function pieceCandidates(piece, resolver, preferredUrls, round) {
      const preferred = Array.isArray(preferredUrls) ? preferredUrls : [];
      // The first preferred address is the node this piece was assigned to by speed;
      // only a retry round moves past it.
      const preferredOffset = preferred.length ? round % preferred.length : 0;
      const rotatedPreferred = preferred.slice(preferredOffset).concat(preferred.slice(0, preferredOffset));
      const rescue = (typeof resolver.rescueCandidates === "function" ? resolver.rescueCandidates() : resolver.ordered(piece.index))
        .filter((url) => !rotatedPreferred.includes(url));
      if (typeof resolver.speed === "function") {
        // The copies after the first go to the fastest known nodes, wherever they were
        // listed: a hedge that lands on the slowest node saves nothing.
        const rest = [...rotatedPreferred.slice(1), ...rescue]
          .sort((left, right) => resolver.speed(right) - resolver.speed(left));
        const candidates = rotatedPreferred.length ? [rotatedPreferred[0], ...rest] : rest;
        for (const url of resolver.ordered(piece.index)) {
          if (!candidates.includes(url)) candidates.push(url);
        }
        return candidates;
      }
      const candidates = [];
      const width = Math.max(rotatedPreferred.length, rescue.length);
      for (let index = 0; index < width; index += 1) {
        if (rotatedPreferred[index]) candidates.push(rotatedPreferred[index]);
        if (rescue[index]) candidates.push(rescue[index]);
      }
      for (const url of resolver.ordered(piece.index)) {
        if (!candidates.includes(url)) candidates.push(url);
      }
      return candidates;
    }

    async function downloadPiece(piece, resolver, signal, kind, preferredUrls, startupMode = false, priority = 0) {
      const settings = config();
      const allowed = (url) => typeof resolver.allows !== "function" || resolver.allows(url);
      const startup = startupMode === true || startupMode === "probe";
      const probe = startupMode === "probe";
      const startedAt = performance.now();
      let lastError = null;

      // The longest contiguous run of bytes fetched from the front of this piece so far.
      // A retry or a hedge copy asks only for what is still missing and splices the two
      // halves, instead of downloading the whole piece again. Every kept byte came out
      // of a response whose 206 Content-Range was verified against this piece.
      let prefix = null;
      const keepProgress = (base, recorder) => {
        const bytes = (base?.bytes || 0) + recorder.bytes;
        if (bytes > (prefix?.bytes || 0) && bytes < piece.length) {
          prefix = { bytes, chunks: base ? [...base.chunks, ...recorder.chunks] : recorder.chunks.slice() };
        }
      };
      const liveProgress = (context) => {
        if (!context) return null;
        const chunks = context.recorder.chunks.slice();
        let bytes = context.base?.bytes || 0;
        for (const chunk of chunks) bytes += chunk.byteLength;
        return { bytes, chunks: context.base ? [...context.base.chunks, ...chunks] : chunks };
      };

      // Failing a piece ends acceleration for the whole video, and the list can be as short as
      // one working address. One slow reply must not decide that, so the list is walked again
      // after a pause; node health and bans have changed by then, so it is rebuilt each time.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), signal);
        }
        const candidates = pieceCandidates(piece, resolver, preferredUrls, round);
        const limit = Math.min(8, candidates.length);
        const batchWidth = probe ? limit : 2;
        const tried = new Set();
        while (tried.size < limit) {
          if (signal?.aborted) throw abortError(signal.reason);
          // A node banned while this piece was waiting is skipped, unless only banned nodes are left.
          const untried = candidates.filter((url) => !tried.has(url));
          const open = untried.filter(allowed);
          const pair = (open.length ? open : untried).slice(0, batchWidth);
          if (!pair.length) break;
          pair.forEach((url) => tried.add(url));
          const controllers = pair.map(() => new AbortController());
          const cancelAll = () => controllers.forEach((controller) => controller.abort(abortError(signal?.reason)));
          if (signal?.aborted) cancelAll();
          else signal?.addEventListener("abort", cancelAll, { once: true });
          // A first copy that is refused at once (HTTP 403) should not leave the piece idle
          // for the rest of the hedge delay.
          let firstFailed = () => {};
          const firstFailure = new Promise((resolve) => { firstFailed = resolve; });
          const contexts = [];
          const attempts = pair.map((url, pairIndex) => (async () => {
            if (pairIndex) await new Promise((resolve, reject) => {
              const delay = probe ? 0 : startup ? Math.min(250, settings.hedgeDelayMs) : hedgeDelayMs(settings);
              const timer = setTimeout(resolve, delay);
              firstFailure.then(() => {
                clearTimeout(timer);
                resolve();
              });
              const canceled = () => {
                clearTimeout(timer);
                reject(abortError(controllers[pairIndex].signal.reason));
              };
              if (controllers[pairIndex].signal.aborted) canceled();
              else controllers[pairIndex].signal.addEventListener("abort", canceled, { once: true });
            });
            // Resume from the longest prefix known right now: an earlier failed attempt,
            // or what the still-running first copy has already received.
            let base = prefix && prefix.bytes >= RESUME_MIN_BYTES ? prefix : null;
            if (pairIndex) {
              const live = liveProgress(contexts[0]);
              if (live && live.bytes >= RESUME_MIN_BYTES && live.bytes > (base?.bytes || 0)) base = live;
            }
            if (base && base.bytes >= piece.length) base = null;
            const recorder = { bytes: 0, chunks: [] };
            contexts[pairIndex] = { base, recorder };
            const part = base
              ? { index: piece.index, start: piece.start + base.bytes, end: piece.end, length: piece.length - base.bytes }
              : piece;
            try {
              const result = await attempt(part, url, controllers[pairIndex].signal, kind, resolver, priority + (pairIndex ? 20 : 0), recorder);
              return base
                ? { bytes: core.concatChunks([...base.chunks, result.bytes], piece.length), total: result.total, url: result.url }
                : result;
            } catch (error) {
              keepProgress(base, recorder);
              if (!pairIndex) firstFailed();
              throw error;
            }
          })());
          try {
            const winner = await Promise.any(attempts);
            controllers.forEach((controller) => {
              if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
            });
            return winner;
          } catch (aggregate) {
            lastError = aggregate?.errors?.at?.(-1) || aggregate;
            if (signal?.aborted) throw abortError(signal.reason);
          } finally {
            signal?.removeEventListener("abort", cancelAll);
          }
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function delayedAttempt(piece, url, delayMs, signal, kind, resolver, controller, priority = 0) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const canceled = () => {
            clearTimeout(timer);
            reject(abortError(controller.signal.reason));
          };
          if (controller.signal.aborted) canceled();
          else controller.signal.addEventListener("abort", canceled, { once: true });
        });
      }
      if (signal?.aborted) throw abortError(signal.reason);
      return attempt(piece, url, controller.signal, kind, resolver, priority);
    }

    async function startupAttempt(piece, candidates, resolver, options) {
      const controllers = candidates.map(() => new AbortController());
      const cancelAll = () => controllers.forEach((controller) => {
        if (!controller.signal.aborted) controller.abort(abortError(options.signal?.reason));
      });
      if (options.signal?.aborted) cancelAll();
      else options.signal?.addEventListener("abort", cancelAll, { once: true });
      try {
        let winner;
        try {
          winner = await Promise.any(candidates.map((url, index) => delayedAttempt(
            piece,
            url,
            index === 0 ? 0 : index === 1 ? 120 : 300,
            options.signal,
            options.kind || "meta",
            resolver,
            controllers[index],
            220
          )));
        } catch (aggregate) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          throw aggregate?.errors?.at?.(-1) || aggregate;
        }
        controllers.forEach((controller) => {
          if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError"));
        });
        return winner;
      } finally {
        options.signal?.removeEventListener("abort", cancelAll);
      }
    }

    // Which address each piece tries first. The fastest node gets the most pieces, a node
    // without a measurement gets the average of the measured ones, and a node measured at
    // under a twelfth of the best is left out entirely: a piece it starts has to be rescued
    // anyway. Slow and untested nodes come back through the resolver's exploration slot.
    function assignPrimaries(urls, resolver, count) {
      if (!urls.length || count <= 0) return [];
      if (urls.length === 1) return new Array(count).fill(urls[0]);
      const measure = typeof resolver.speed === "function" ? (url) => Math.max(0, Number(resolver.speed(url)) || 0) : () => 0;
      let known = urls.map(measure);
      const positive = known.filter((value) => value > 0);
      if (!positive.length) return Array.from({ length: count }, (_ignored, index) => urls[index % urls.length]);
      const top = Math.max(...known);
      const eligible = urls.filter((_url, index) => !known[index] || known[index] >= top / 12);
      if (eligible.length && eligible.length < urls.length) {
        urls = eligible;
        known = urls.map(measure);
      }
      const fallback = positive.reduce((sum, value) => sum + value, 0) / positive.length;
      const weights = known.map((value) => Math.max(value || fallback, top * 0.05));
      const total = weights.reduce((sum, value) => sum + value, 0);
      const primaries = [];
      let urlIndex = 0;
      let covered = weights[0];
      for (let index = 0; index < count; index += 1) {
        const point = (index + 0.5) * total / count;
        while (covered < point && urlIndex < urls.length - 1) {
          urlIndex += 1;
          covered += weights[urlIndex];
        }
        primaries.push(urls[urlIndex]);
      }
      return primaries;
    }

    function preferredFor(primary, urls) {
      return primary ? [primary, ...urls.filter((url) => url !== primary)] : urls;
    }

    async function downloadStartupRange(range, resolver, options) {
      semaphore.setLimit(config().concurrency);
      const piece = { index: 0, start: range.start, end: range.end, length: range.length };
      const startedAt = performance.now();
      let lastError = null;
      // The addresses that just failed are backing off by the next round, so each round
      // moves on to the next three.
      for (let round = 0; round < PIECE_ROUNDS; round += 1) {
        if (round) {
          if (performance.now() - startedAt > PIECE_RETRY_WINDOW_MS) break;
          await pause(Math.min(2000, 500 * (2 ** (round - 1))), options.signal);
        }
        let candidates = (typeof resolver.startupCandidates === "function" ? resolver.startupCandidates() : resolver.urls())
          .filter((url, index, all) => all.indexOf(url) === index)
          .slice(0, 3);
        if (!candidates.length && round) candidates = resolver.ordered(round).slice(0, 3);
        if (!candidates.length) break;
        try {
          const winner = await startupAttempt(piece, candidates, resolver, options);
          return {
            bytes: winner.bytes,
            pieceCount: 1,
            total: winner.total || null,
            hosts: [new URL(winner.url).hostname]
          };
        } catch (error) {
          if (options.signal?.aborted) throw abortError(options.signal.reason);
          lastError = error;
        }
      }
      throw lastError || new Error("没有可用 CDN");
    }

    async function downloadStartupMediaRange(range, resolver, options, settings) {
      const effectiveConcurrency = settings.concurrency;
      semaphore.setLimit(effectiveConcurrency);
      const candidateUrls = (typeof resolver.rangeCandidates === "function" ? resolver.rangeCandidates() : resolver.urls())
        .filter((url, index, all) => all.indexOf(url) === index);
      const headLength = Math.min(range.length, Math.max(64 * 1024, settings.minChunkBytes));
      const head = {
        index: 0,
        start: range.start,
        end: range.start + headLength - 1,
        length: headLength
      };
      const headResult = await downloadPiece(
        head,
        resolver,
        options.signal,
        options.kind || "media",
        candidateUrls,
        "probe",
        220
      );
      await options.onOrderedChunk(headResult.bytes, head, headResult.total);
      if (head.end >= range.end) {
        options.onStartupScheduled?.();
        return {
          bytes: null,
          byteLength: range.length,
          pieceCount: 1,
          streamed: true,
          total: headResult.total || null,
          hosts: [new URL(headResult.url).hostname]
        };
      }

      const rescueReserve = Math.max(1, Math.min(16, Math.ceil(effectiveConcurrency / 8)));
      const mediaBudget = Math.max(1, effectiveConcurrency - rescueReserve);
      const audioBudget = Math.max(1, Math.min(mediaBudget, Math.ceil(effectiveConcurrency / 8)));
      const pieceBudget = options.kind === "audio"
        ? audioBudget
        : Math.max(1, mediaBudget - audioBudget);
      const pieces = core.splitRange(
        head.end + 1,
        range.end,
        pieceBudget,
        adaptiveMinChunk(settings, range.end - head.end, pieceBudget, candidateUrls.length)
      ).map((piece, index) => ({ ...piece, index: index + 1 }));
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex], item.total);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      // The probe measured at least its own winner, so the pieces spread over the nodes by
      // speed at once; the proven address stays each piece's first fallback.
      const primaries = assignPrimaries(candidateUrls, resolver, pieces.length);
      const pendingPieces = pieces.map(async (piece, orderedIndex) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[orderedIndex], [headResult.url, ...candidateUrls.filter((url) => url !== headResult.url)]),
          true,
          120 - Math.min(30, piece.index)
        );
        ordered[orderedIndex] = result;
        await flushOrdered();
        return result;
      });
      options.onStartupScheduled?.();
      const results = await Promise.all(pendingPieces);
      await flushOperation;
      const totals = [headResult, ...results].map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: null,
        byteLength: range.length,
        pieceCount: pieces.length + 1,
        streamed: true,
        total: totals[0] || null,
        hosts: [...new Set([headResult, ...results].map((item) => new URL(item.url).hostname))]
      };
    }

    async function downloadRange(range, resolver, options = {}) {
      const settings = config();
      if (options.kind === "meta") return downloadStartupRange(range, resolver, options);
      const parallel = options.parallel !== false;
      if (options.startup === true && parallel && typeof options.onOrderedChunk === "function") {
        return downloadStartupMediaRange(range, resolver, options, settings);
      }
      const preferredUrls = parallel && typeof resolver.rangeCandidates === "function"
        ? resolver.rangeCandidates()
        : resolver.urls();
      const globalConcurrency = parallel ? settings.concurrency : 1;
      const requestedConcurrency = Number.isFinite(Number(options.maxConcurrency))
        ? Math.max(1, Math.trunc(Number(options.maxConcurrency)))
        : globalConcurrency;
      const effectiveConcurrency = parallel ? Math.min(globalConcurrency, requestedConcurrency) : 1;
      // 后台预取可以限制自己的子块数，但不能降低全局信号量上限；
      // 否则一个低优先级预取会把后续播放器的紧急请求也锁在低并发上。
      semaphore.setLimit(globalConcurrency);
      const basePriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 50;
      const rescueReserve = parallel && effectiveConcurrency >= 8
        ? Math.min(8, Math.max(1, Math.ceil(effectiveConcurrency / 8)))
        : 0;
      const pieceConcurrency = options.startup === true
        ? Math.max(1, Math.min(22, effectiveConcurrency))
        : Math.max(1, effectiveConcurrency - rescueReserve);
      const pieces = core.splitRange(
        range.start,
        range.end,
        pieceConcurrency,
        parallel ? adaptiveMinChunk(settings, range.length, pieceConcurrency, preferredUrls.length) : Number.MAX_SAFE_INTEGER
      );
      const primaries = parallel ? assignPrimaries(preferredUrls, resolver, pieces.length) : [];
      const progressive = typeof options.onOrderedChunk === "function";
      const ordered = new Array(pieces.length);
      let nextOrderedIndex = 0;
      let flushOperation = Promise.resolve();
      const flushOrdered = () => {
        flushOperation = flushOperation.then(async () => {
          while (ordered[nextOrderedIndex]) {
            const item = ordered[nextOrderedIndex];
            ordered[nextOrderedIndex] = null;
            await options.onOrderedChunk(item.bytes, pieces[nextOrderedIndex], item.total);
            nextOrderedIndex += 1;
          }
        });
        return flushOperation;
      };
      const results = await Promise.all(pieces.map(async (piece) => {
        const result = await downloadPiece(
          piece,
          resolver,
          options.signal,
          options.kind || "media",
          preferredFor(primaries[piece.index], preferredUrls),
          options.startup === true,
          basePriority - Math.min(20, piece.index)
        );
        if (progressive) {
          ordered[piece.index] = result;
          await flushOrdered();
        }
        return result;
      }));
      if (progressive) await flushOperation;
      const totals = results.map((item) => item.total).filter(Number.isSafeInteger);
      if (totals.length && totals.some((value) => value !== totals[0])) throw new Error("不同 CDN 返回的文件总长度不一致");
      return {
        bytes: progressive ? null : core.concatChunks(results.map((item) => item.bytes), range.length),
        byteLength: range.length,
        pieceCount: pieces.length,
        streamed: progressive,
        total: totals[0] || null,
        hosts: [...new Set(results.map((item) => new URL(item.url).hostname))]
      };
    }

    return Object.freeze({ downloadRange, applySettings: () => semaphore.setLimit(config().concurrency) });
  }

  root.__BILI_IDM_DOWNLOADER_FACTORY__ = Object.freeze({ createDownloader });
})(globalThis);
