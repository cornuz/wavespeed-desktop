/**
 * useEditorLayout — manages active preset and panel sizes for the Composer editor.
 *
 * - Initialises from project.layoutPreset / project.layoutSizes (merged with DEFAULT_SIZES)
 * - Exposes resize handlers that update local state and debounce a DB save (500 ms)
 * - No localStorage — DB is the single source of truth
 *
 * Resize implementation mirrors PlaygroundPage.tsx (document mousemove pattern).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerProject, LayoutPreset, LayoutSizesMap } from "@/composer/types/project";
import type { LayoutSizesEqual, LayoutSizesFeatured } from "@/composer/types/project";
import { composerProjectIpc } from "@/composer/ipc/ipc-client";
import {
  DEFAULT_SIZES,
  PRESET_CONFIGS,
} from "./layout-presets";

// ─── Helper: resolve merged sizes for a preset ────────────────────────────────

function getSizes<T extends LayoutSizesEqual | LayoutSizesFeatured>(
  preset: LayoutPreset,
  storedMap: LayoutSizesMap,
): T {
  const stored = storedMap[preset] as T | undefined;
  const defaults = DEFAULT_SIZES[preset] as T;
  return stored ? { ...defaults, ...stored } : { ...defaults };
}

// ─── Hook types ───────────────────────────────────────────────────────────────

export interface EditorLayoutState {
  activePreset: LayoutPreset;
  /** Sizes for the current activePreset */
  sizes: LayoutSizesEqual | LayoutSizesFeatured;
  setPreset: (p: LayoutPreset) => void;
  /** Handle refs for resize dividers */
  handles: {
    /** Drag divider between left and center (or top-left / top-right) in top row */
    onMouseDownTopLeft: (e: React.MouseEvent) => void;
    /** Drag divider between center and right in top row (equal mode only) */
    onMouseDownTopRight: (e: React.MouseEvent) => void;
    /** Drag the featured column divider (featured mode only) */
    onMouseDownFeatured: (e: React.MouseEvent) => void;
    /** Drag the timeline height divider */
    onMouseDownTimeline: (e: React.MouseEvent) => void;
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useEditorLayout(project: ComposerProject): EditorLayoutState {
  const [activePreset, setActivePreset] = useState<LayoutPreset>(
    project.layoutPreset ?? "timeline",
  );
  const [sizesMap, setSizesMap] = useState<LayoutSizesMap>(() => ({
    ...project.layoutSizes,
  }));

  // --- Resize drag state -------------------------------------------------------
  // We store the current drag type and starting info in refs to avoid stale closures.
  type DragType = "topLeft" | "topRight" | "featured" | "timeline" | null;
  const dragType = useRef<DragType>(null);
  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragStartValue = useRef(0);
  // Container dimension snapshot taken at drag start (pixels)
  const containerW = useRef(0);
  const containerH = useRef(0);
  const containerRef = useRef<HTMLElement | null>(null);

  // Stable ref for current preset / sizes (avoids effect dependency churn)
  const activePresetRef = useRef(activePreset);
  activePresetRef.current = activePreset;
  const sizesMapRef = useRef(sizesMap);
  sizesMapRef.current = sizesMap;

  // --- Debounced DB save -------------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback(
    (preset: LayoutPreset, map: LayoutSizesMap) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        composerProjectIpc
          .save({ id: project.id, layoutPreset: preset, layoutSizes: map })
          .catch((err) => console.error("[Composer] layout save failed", err));
      }, 500);
    },
    [project.id],
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // --- Preset change -----------------------------------------------------------
  const setPreset = useCallback(
    (p: LayoutPreset) => {
      setActivePreset(p);
      setSizesMap((prev) => {
        // Immediately save — no debounce for preset changes
        composerProjectIpc
          .save({ id: project.id, layoutPreset: p, layoutSizes: prev })
          .catch((err) => console.error("[Composer] preset save failed", err));
        return prev;
      });
    },
    [project.id],
  );

  // --- Mouse-move handler (document level) ------------------------------------
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragType.current) return;
      const preset = activePresetRef.current;
      const map = sizesMapRef.current;
      const cfg = PRESET_CONFIGS[preset];

      setSizesMap((prev) => {
        const current = getSizes(preset, prev);
        let next = { ...current };

        const dx = e.clientX - dragStartX.current;
        const dy = e.clientY - dragStartY.current;

        if (dragType.current === "timeline") {
          // timeline height: drag upward increases ratio
          const delta = -dy / (containerH.current || 1);
          const raw = dragStartValue.current + delta;
          (next as LayoutSizesEqual).timelineH = Math.min(0.70, Math.max(0.10, raw));
        } else if (dragType.current === "featured" && cfg.mode === "featured") {
          const delta = dx / (containerW.current || 1);
          const raw = dragStartValue.current + delta * (cfg.featuredSide === "left" ? 1 : -1);
          (next as LayoutSizesFeatured).featuredW = Math.min(0.60, Math.max(0.15, raw));
        } else if (dragType.current === "topLeft") {
          const delta = dx / (containerW.current || 1);
          if (cfg.mode === "equal") {
            const raw = dragStartValue.current + delta;
            (next as LayoutSizesEqual).assetsW = Math.min(0.50, Math.max(0.10, raw));
          } else {
            const raw = dragStartValue.current + delta;
            (next as LayoutSizesFeatured).topSplitW = Math.min(0.80, Math.max(0.20, raw));
          }
        } else if (dragType.current === "topRight" && cfg.mode === "equal") {
          // dragging the right divider reduces propsW
          const delta = -dx / (containerW.current || 1);
          const raw = dragStartValue.current + delta;
          (next as LayoutSizesEqual).propsW = Math.min(0.50, Math.max(0.10, raw));
        }

        const updated: LayoutSizesMap = { ...map, [preset]: next };
        scheduleSave(preset, updated);
        return updated;
      });
    }

    function onMouseUp() {
      dragType.current = null;
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [scheduleSave]);

  // --- Snapshot container dimensions at drag start ----------------------------
  function snapshotContainer() {
    // Walk up from the drag handle to find the editor container
    const el = document.querySelector("[data-composer-editor]") as HTMLElement | null;
    containerRef.current = el;
    containerW.current = el?.offsetWidth ?? 1000;
    containerH.current = el?.offsetHeight ?? 600;
  }

  // --- Drag start helpers -----------------------------------------------------
  const makeDragStart = useCallback(
    (type: NonNullable<DragType>, valueGetter: () => number) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        snapshotContainer();
        dragType.current = type;
        dragStartX.current = e.clientX;
        dragStartY.current = e.clientY;
        dragStartValue.current = valueGetter();
      },
    [],
  );

  const handles: EditorLayoutState["handles"] = {
    onMouseDownTopLeft: makeDragStart("topLeft", () => {
      const s = getSizes(activePresetRef.current, sizesMapRef.current);
      return PRESET_CONFIGS[activePresetRef.current].mode === "equal"
        ? (s as LayoutSizesEqual).assetsW
        : (s as LayoutSizesFeatured).topSplitW;
    }),
    onMouseDownTopRight: makeDragStart("topRight", () => {
      const s = getSizes(activePresetRef.current, sizesMapRef.current);
      return (s as LayoutSizesEqual).propsW ?? 0.25;
    }),
    onMouseDownFeatured: makeDragStart("featured", () => {
      const s = getSizes(activePresetRef.current, sizesMapRef.current);
      return (s as LayoutSizesFeatured).featuredW ?? 0.25;
    }),
    onMouseDownTimeline: makeDragStart("timeline", () => {
      const s = getSizes(activePresetRef.current, sizesMapRef.current);
      return s.timelineH;
    }),
  };

  const currentSizes = getSizes(activePreset, sizesMap);

  return { activePreset, sizes: currentSizes, setPreset, handles };
}
