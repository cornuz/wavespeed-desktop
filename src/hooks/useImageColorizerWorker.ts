import { useCallback, useEffect, useRef } from "react";
import type { ProgressDetail } from "@/types/progress";

export type ColorizeMode = "ai" | "natural" | "vintage" | "vivid" | "portrait";

export interface ColorizeOptions {
  mode: ColorizeMode;
  strength: number;
  saturation: number;
  preserveContrast: boolean;
}

interface WorkerMessage {
  type: "phase" | "progress" | "result" | "error" | "disposed";
  payload?: unknown;
}

interface PhasePayload {
  phase: string;
  id: number;
}

interface ProgressPayload {
  phase: string;
  progress: number;
  detail?: ProgressDetail;
  id: number;
}

interface ResultPayload {
  arrayBuffer: ArrayBuffer;
  id: number;
}

interface ErrorPayload {
  message: string;
  id?: number;
}

interface UseImageColorizerWorkerOptions {
  onPhase?: (phase: string) => void;
  onProgress?: (
    phase: string,
    progress: number,
    detail?: ProgressDetail,
  ) => void;
  onError?: (error: string) => void;
}

export function useImageColorizerWorker(
  options: UseImageColorizerWorkerOptions = {},
) {
  const workerRef = useRef<Worker | null>(null);
  const requestsRef = useRef<
    Map<
      number,
      {
        resolve: (result: Blob) => void;
        reject: (error: Error) => void;
      }
    >
  >(new Map());
  const idCounterRef = useRef(0);
  const optionsRef = useRef(options);
  const hasFailedRef = useRef(false);

  optionsRef.current = options;

  const createWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
    }
    hasFailedRef.current = false;

    workerRef.current = new Worker(
      new URL("../workers/imageColorizer.worker.ts", import.meta.url),
      { type: "module" },
    );

    workerRef.current.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const { type, payload } = e.data;

      switch (type) {
        case "phase": {
          const { phase } = payload as PhasePayload;
          optionsRef.current.onPhase?.(phase);
          break;
        }
        case "progress": {
          const { phase, progress, detail } = payload as ProgressPayload;
          optionsRef.current.onProgress?.(phase, progress, detail);
          break;
        }
        case "result": {
          const { arrayBuffer, id } = payload as ResultPayload;
          const request = requestsRef.current.get(id);
          if (request) {
            request.resolve(new Blob([arrayBuffer], { type: "image/png" }));
            requestsRef.current.delete(id);
          }
          break;
        }
        case "error": {
          const errorPayload =
            typeof payload === "string"
              ? { message: payload }
              : (payload as ErrorPayload);
          const error = new Error(errorPayload.message);
          hasFailedRef.current = true;
          optionsRef.current.onError?.(errorPayload.message);
          if (errorPayload.id !== undefined) {
            const request = requestsRef.current.get(errorPayload.id);
            if (request) {
              request.reject(error);
              requestsRef.current.delete(errorPayload.id);
            }
          } else {
            requestsRef.current.forEach((request) => request.reject(error));
            requestsRef.current.clear();
          }
          break;
        }
      }
    };
  }, []);

  const ensureWorker = useCallback(() => {
    if (!workerRef.current) {
      createWorker();
    }
  }, [createWorker]);

  useEffect(() => {
    createWorker();

    return () => {
      workerRef.current?.postMessage({ type: "dispose" });
      workerRef.current?.terminate();
      workerRef.current = null;
      requestsRef.current.forEach((request) =>
        request.reject(new Error("Worker disposed")),
      );
      requestsRef.current.clear();
    };
  }, [createWorker]);

  const colorize = useCallback(
    (imageBlob: Blob, colorizeOptions: ColorizeOptions): Promise<Blob> =>
      new Promise((resolve, reject) => {
        ensureWorker();

        if (!workerRef.current) {
          reject(new Error("Worker not initialized"));
          return;
        }

        const id = idCounterRef.current++;
        requestsRef.current.set(id, { resolve, reject });

        workerRef.current.postMessage({
          type: "process",
          payload: { imageBlob, options: colorizeOptions, id },
        });
      }),
    [ensureWorker],
  );

  const dispose = useCallback(() => {
    workerRef.current?.postMessage({ type: "dispose" });
    workerRef.current?.terminate();
    workerRef.current = null;
    requestsRef.current.forEach((request) =>
      request.reject(new Error("Worker disposed")),
    );
    requestsRef.current.clear();
  }, []);

  const retryWorker = useCallback(() => {
    createWorker();
  }, [createWorker]);

  const hasFailed = useCallback(() => hasFailedRef.current, []);

  return {
    colorize,
    dispose,
    retryWorker,
    hasFailed,
  };
}
