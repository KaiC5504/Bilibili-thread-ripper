// The SourceBuffer.buffered shim: while a takeover is active, reading buffered on a buffer
// that was detached from its MediaSource answers with an empty range instead of throwing
// the InvalidStateError that floods Bilibili's own error reporting on HDR/8K sources.
(function installBufferedShimTest(root) {
  "use strict";

  root.__runBufferedShimTest = async function runBufferedShimTest() {
    const result = document.getElementById("buffered-shim-result");
    const output = { checks: {} };
    try {
      const video = document.querySelector("video");
      const mediaSource = new MediaSource();
      video.src = URL.createObjectURL(mediaSource);
      await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
      const buffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
      output.checks.normalReadWorks = buffer.buffered.length === 0;
      mediaSource.removeSourceBuffer(buffer);

      // Without an active takeover the browser behaves as before: the read throws.
      let threw = "";
      try { void buffer.buffered; } catch (error) { threw = error.name; }
      output.checks.throwsWithoutTakeover = threw === "InvalidStateError";

      // With a takeover active the read answers an empty range.
      document.querySelector(".bpx-player-container").dataset.btrMseActive = "true";
      const ranges = buffer.buffered;
      output.checks.emptyDuringTakeover = ranges.length === 0;
      let indexThrew = "";
      try { ranges.start(0); } catch (error) { indexThrew = error.name; }
      output.checks.indexStillThrows = indexThrew === "IndexSizeError";
      delete document.querySelector(".bpx-player-container").dataset.btrMseActive;

      // A healthy buffer is untouched by the shim.
      const second = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028"');
      output.checks.healthyBufferUntouched = second.buffered.length === 0;

      output.pass = Object.values(output.checks).every(Boolean);
    } catch (error) {
      output.error = String(error?.stack || error);
      output.pass = false;
    }
    result.textContent = JSON.stringify(output);
    result.dataset.pass = String(output.pass);
  };
})(globalThis);
