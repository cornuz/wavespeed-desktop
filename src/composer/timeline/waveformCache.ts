type WaveformEntry = {
  peaks: number[];
  positions?: number[];
  duration: number;
  bucketCount?: number;
};

// In-memory cache keyed by composite key: "<projectId>::<src>"
const cache = new Map<string, WaveformEntry>();

function makeCacheKey(src: string, projectId?: string | null) {
  return `${projectId ?? "global"}::${src}`;
}

export function getCachedPeaks(src: string, projectId?: string | null): WaveformEntry | undefined {
  return cache.get(makeCacheKey(src, projectId));
}

export async function ensurePeaks(src: string, bucketCount?: number, projectId?: string | null): Promise<WaveformEntry> {
  if (!src) {
    throw new Error("No source provided");
  }

  const key = makeCacheKey(src, projectId);
  const existing = cache.get(key);
  if (existing) return existing;

  // Try persistent store first (Electron preload exposes electronAPI.getState/setState)
  const electronAPI = (window as any).electronAPI as {
    getState?: (k: string) => Promise<unknown>;
    setState?: (k: string, v: unknown) => Promise<boolean>;
  } | null;

  if (electronAPI && typeof electronAPI.getState === "function") {
    try {
      const persisted = await electronAPI.getState(`composer:waveform:${key}`);
      if (persisted && typeof persisted === "object") {
        const p = persisted as WaveformEntry;
        if (Array.isArray(p.peaks) && typeof p.duration === "number") {
          cache.set(key, p);
          return p;
        }
      }
    } catch {
      // ignore persistent read errors and fall back to recompute
    }
  }

  // Fetch and decode audio on the main thread (AudioContext), then offload
  // peak computation to a worker for CPU-bound work.
  const response = await fetch(src);
  const arrayBuffer = await response.arrayBuffer();

  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("AudioContext not available");
  }

  const audioCtx = new AudioCtx();
  // decodeAudioData accepts ArrayBuffer
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  const duration = audioBuffer.duration;
  const raw = audioBuffer.getChannelData(0);

  // Determine bucket count: default to 0.1s per bucket (1/10s unit)
  const MAX_BUCKETS = 65536;
  let computedBucketCount: number;
  if (typeof bucketCount === "number" && bucketCount > 0) {
    computedBucketCount = Math.min(MAX_BUCKETS, Math.floor(bucketCount));
  } else {
    computedBucketCount = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(duration / 0.1)));
  }

  // Create worker
  const worker = new Worker(new URL("../workers/waveform.worker.ts", import.meta.url));

  const peaksPromise: Promise<{ peaks: number[]; positions?: number[] }> = new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data || {};
      if (data.error) {
        worker.removeEventListener("message", onMessage);
        worker.terminate();
        reject(new Error(String(data.error)));
        return;
      }
      if (Array.isArray(data.peaks)) {
        worker.removeEventListener("message", onMessage);
        worker.terminate();
        resolve({ peaks: data.peaks as number[], positions: Array.isArray(data.positions) ? (data.positions as number[]) : undefined });
      }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", (err) => {
      worker.terminate();
      reject(err instanceof Error ? err : new Error("Worker error"));
    });
  });

  // Transfer the underlying buffer for performance (main thread no longer needs it)
  try {
    worker.postMessage({ cmd: "compute", buffer: raw.buffer, bucketCount: computedBucketCount }, [raw.buffer]);
  } catch (e) {
    // Fallback: structured clone (some browsers may not allow transfer)
    worker.postMessage({ cmd: "compute", buffer: raw.slice(0).buffer, bucketCount: computedBucketCount });
  }

  const result = await peaksPromise;
  const peaks = result.peaks;
  const positions = result.positions;
  const entry: WaveformEntry = { peaks, positions, duration, bucketCount: computedBucketCount };
  cache.set(key, entry);

  // Persist to disk if possible
  if (electronAPI && typeof electronAPI.setState === "function") {
    try {
      // Be tolerant of failures (don't block UI)
      void electronAPI.setState(`composer:waveform:${key}`, entry);
    } catch {
      // ignore
    }
  }

  try {
    await audioCtx.close();
  } catch {
    // ignore
  }
  return entry;
}
