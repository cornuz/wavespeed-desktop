import React, { useEffect, useRef, useState } from "react";
import { ensurePeaks, getCachedPeaks } from "./waveformCache";

interface Props {
  src: string | null | undefined;
  width: number;
  height?: number;
  className?: string;
  projectId?: string | null;
}

export default function AudioWaveform({ src, width, height = 44, projectId = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    if (!src) {
      setPeaks(null);
      return;
    }

    const cached = getCachedPeaks(src ?? "", projectId);
    let mounted = true;

    if (cached) {
      setPeaks(cached.peaks.slice(0));
      return () => {
        mounted = false;
      };
    }

    void (async () => {
      try {
        // Default bucketing: 0.1s per bucket (handled by ensurePeaks)
        const entry = await ensurePeaks(src, undefined, projectId);
        if (!mounted) return;
        setPeaks(entry.peaks.slice(0));
      } catch (err) {
        setPeaks(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.floor(width));
    const cssHeight = Math.max(1, Math.floor(height));

    // Cap canvas pixel dimensions to avoid browser white/OOM issues when zooming
    const MAX_CANVAS_PIXELS = 32768; // per-dimension cap
    const targetPixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const targetPixelHeight = Math.max(1, Math.floor(cssHeight * dpr));
    const pixelWidth = Math.min(targetPixelWidth, MAX_CANVAS_PIXELS);
    const pixelHeight = Math.min(targetPixelHeight, MAX_CANVAS_PIXELS);

    // Setting width/height clears the canvas
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.style.backgroundColor = "transparent";

    if (!peaks || peaks.length === 0) return;

    // Compute transform so we draw in CSS pixels while canvas may be capped
    const scaleX = pixelWidth / cssWidth;
    const scaleY = pixelHeight / cssHeight;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    // Clear in CSS-space
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Use a consistent dark semi-transparent color for bars (40% opacity)
    ctx.fillStyle = "rgba(0,0,0,0.4)";

    const peaksLen = peaks.length;

    // Draw one CSS-pixel-wide column per css X coordinate, sampling/interpolating peaks
    for (let x = 0; x < cssWidth; x++) {
      // Map x -> sample position in peaks
      const samplePos = (x + 0.5) / cssWidth * peaksLen;
      const i0 = Math.floor(samplePos);
      const frac = samplePos - i0;
      const v0 = peaks[i0] ?? 0;
      const v1 = peaks[Math.min(peaksLen - 1, i0 + 1)] ?? v0;
      const v = v0 + (v1 - v0) * frac;
      const barHeight = Math.max(1, Math.round(v * cssHeight * 0.9));
      const y = cssHeight - barHeight;
      ctx.fillRect(x, y, 1, barHeight);
    }

    // Dots removed (apex-dot feature disabled to avoid rendering/CPU bottleneck).
  }, [peaks, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-0"
      aria-hidden
    />
  );
}
