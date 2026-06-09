/* eslint-disable no-restricted-globals */
self.onmessage = (ev) => {
  try {
    const data = ev.data || {};
    if (data.cmd !== "compute") {
      return;
    }

    const buffer = data.buffer;
    const bucketCount = Math.max(1, Math.floor(data.bucketCount || 256));
    const floatData = new Float32Array(buffer);
    const len = floatData.length;
    const blockSize = Math.max(1, Math.floor(len / bucketCount));
    const peaks = new Float32Array(bucketCount);

    for (let i = 0; i < bucketCount; i++) {
      const start = i * blockSize;
      const end = i === bucketCount - 1 ? len : start + blockSize;
      let max = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(floatData[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }

    // Normalize peaks to 0..1
    let maxPeak = 0;
    for (let i = 0; i < peaks.length; i++) {
      if (peaks[i] > maxPeak) maxPeak = peaks[i];
    }
    if (maxPeak > 0) {
      for (let i = 0; i < peaks.length; i++) {
        peaks[i] = peaks[i] / maxPeak;
      }
    }

    // Post back peaks only (positions removed for performance)
    self.postMessage({ peaks: Array.from(peaks) });
  } catch (err) {
    // best-effort: report error
    // @ts-ignore
    self.postMessage({ error: (err && err.message) || String(err) });
  }
};
