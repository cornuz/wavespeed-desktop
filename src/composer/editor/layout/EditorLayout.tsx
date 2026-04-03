/**
 * EditorLayout — pure layout renderer for the Composer editor shell.
 *
 * Handles two modes:
 *   - equal    : 3 panels in a flex row above the Timeline
 *   - featured : one featured column + [top-row(2 panels) + Timeline]
 *
 * All sizes are ratios (0–1); converted to % for CSS flex.
 * See sources/multi-layout-spec.md for the full spec.
 */
import React from "react";
import { cn } from "@/lib/utils";
import type { LayoutSizesEqual, LayoutSizesFeatured } from "@/composer/types/project";
import type { EditorLayoutState } from "./useEditorLayout";
import { PRESET_CONFIGS } from "./layout-presets";
import { AssetsPanel } from "../panels/AssetsPanel";
import { PlayerPanel } from "../panels/PlayerPanel";
import { PropertiesPanel } from "../panels/PropertiesPanel";
import { TimelinePanel } from "../panels/TimelinePanel";

// ─── Divider component ────────────────────────────────────────────────────────

interface DividerProps {
  orientation: "vertical" | "horizontal";
  onMouseDown: (e: React.MouseEvent) => void;
}

function Divider({ orientation, onMouseDown }: DividerProps) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={cn(
        "shrink-0 flex items-center justify-center transition-colors group",
        orientation === "vertical"
          ? "w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
          : "h-1 cursor-row-resize hover:bg-primary/20 active:bg-primary/30",
      )}
    >
      <div
        className={cn(
          "bg-border transition-colors group-hover:bg-primary/50",
          orientation === "vertical" ? "w-px h-8" : "h-px w-8",
        )}
      />
    </div>
  );
}

// ─── Panel resolver ───────────────────────────────────────────────────────────

function renderPanel(id: "assets" | "player" | "properties") {
  switch (id) {
    case "assets":     return <AssetsPanel />;
    case "player":     return <PlayerPanel />;
    case "properties": return <PropertiesPanel />;
  }
}

// ─── Layout modes ─────────────────────────────────────────────────────────────

interface EqualLayoutProps {
  sizes: LayoutSizesEqual;
  handles: EditorLayoutState["handles"];
}

function EqualLayout({ sizes, handles }: EqualLayoutProps) {
  const { timelineH, assetsW, propsW } = sizes;
  const playerW = 1 - assetsW - propsW;

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      {/* Top row */}
      <div className="flex flex-row min-h-0" style={{ flex: `${1 - timelineH} 0 0` }}>
        {/* Assets */}
        <div className="min-w-0 min-h-0 overflow-hidden" style={{ flex: `${assetsW} 0 0` }}>
          <AssetsPanel />
        </div>

        <Divider orientation="vertical" onMouseDown={handles.onMouseDownTopLeft} />

        {/* Player */}
        <div className="min-w-0 min-h-0 overflow-hidden" style={{ flex: `${playerW} 0 0` }}>
          <PlayerPanel />
        </div>

        <Divider orientation="vertical" onMouseDown={handles.onMouseDownTopRight} />

        {/* Properties */}
        <div className="min-w-0 min-h-0 overflow-hidden" style={{ flex: `${propsW} 0 0` }}>
          <PropertiesPanel />
        </div>
      </div>

      <Divider orientation="horizontal" onMouseDown={handles.onMouseDownTimeline} />

      {/* Timeline */}
      <div className="min-h-0 overflow-hidden" style={{ flex: `${timelineH} 0 0` }}>
        <TimelinePanel />
      </div>
    </div>
  );
}

interface FeaturedLayoutProps {
  sizes: LayoutSizesFeatured;
  handles: EditorLayoutState["handles"];
  featuredSide: "left" | "right";
  featuredPanel: "assets" | "player" | "properties";
  topRowPanels: ["assets" | "player" | "properties", "assets" | "player" | "properties"];
}

function FeaturedLayout({ sizes, handles, featuredSide, featuredPanel, topRowPanels }: FeaturedLayoutProps) {
  const { timelineH, featuredW, topSplitW } = sizes;
  const mainW = 1 - featuredW;

  const featured = (
    <div className="min-w-0 min-h-0 h-full overflow-hidden" style={{ flex: `${featuredW} 0 0` }}>
      {renderPanel(featuredPanel)}
    </div>
  );

  const mainCol = (
    <div className="flex flex-col min-w-0 min-h-0 h-full" style={{ flex: `${mainW} 0 0` }}>
      {/* Top row — 2 panels */}
      <div className="flex flex-row min-h-0" style={{ flex: `${1 - timelineH} 0 0` }}>
        <div className="min-w-0 min-h-0 overflow-hidden" style={{ flex: `${topSplitW} 0 0` }}>
          {renderPanel(topRowPanels[0])}
        </div>
        <Divider orientation="vertical" onMouseDown={handles.onMouseDownTopLeft} />
        <div className="min-w-0 min-h-0 overflow-hidden" style={{ flex: `${1 - topSplitW} 0 0` }}>
          {renderPanel(topRowPanels[1])}
        </div>
      </div>

      <Divider orientation="horizontal" onMouseDown={handles.onMouseDownTimeline} />

      {/* Timeline */}
      <div className="min-h-0 overflow-hidden" style={{ flex: `${timelineH} 0 0` }}>
        <TimelinePanel />
      </div>
    </div>
  );

  return (
    <div className="flex flex-row h-full w-full min-h-0">
      {featuredSide === "left" ? (
        <>
          {featured}
          <Divider orientation="vertical" onMouseDown={handles.onMouseDownFeatured} />
          {mainCol}
        </>
      ) : (
        <>
          {mainCol}
          <Divider orientation="vertical" onMouseDown={handles.onMouseDownFeatured} />
          {featured}
        </>
      )}
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface EditorLayoutProps {
  layout: EditorLayoutState;
}

export function EditorLayout({ layout }: EditorLayoutProps) {
  const { activePreset, sizes, handles } = layout;
  const cfg = PRESET_CONFIGS[activePreset];

  if (cfg.mode === "equal") {
    return <EqualLayout sizes={sizes as LayoutSizesEqual} handles={handles} />;
  }

  return (
    <FeaturedLayout
      sizes={sizes as LayoutSizesFeatured}
      handles={handles}
      featuredSide={cfg.featuredSide}
      featuredPanel={cfg.featuredPanel as "assets" | "player" | "properties"}
      topRowPanels={cfg.topRowPanels as ["assets" | "player" | "properties", "assets" | "player" | "properties"]}
    />
  );
}
