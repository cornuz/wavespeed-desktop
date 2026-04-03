/**
 * Static configuration for the 4 editor layout presets.
 * See sources/multi-layout-spec.md for the full spec.
 */
import type {
  LayoutPreset,
  LayoutSizesEqual,
  LayoutSizesFeatured,
} from "@/composer/types/project";

// ─── Panel identifiers ────────────────────────────────────────────────────────

export type PanelId = "assets" | "player" | "properties" | "timeline";

// ─── Preset config ────────────────────────────────────────────────────────────

interface PresetConfigEqual {
  mode: "equal";
  /** Ordered left-to-right */
  topRowPanels: [PanelId, PanelId, PanelId];
}

interface PresetConfigFeatured {
  mode: "featured";
  featuredSide: "left" | "right";
  featuredPanel: PanelId;
  /** Ordered left-to-right within the non-featured column's top-row */
  topRowPanels: [PanelId, PanelId];
}

export type PresetConfig = PresetConfigEqual | PresetConfigFeatured;

export const PRESET_CONFIGS: Record<LayoutPreset, PresetConfig> = {
  timeline: {
    mode: "equal",
    topRowPanels: ["assets", "player", "properties"],
  },
  assets: {
    mode: "featured",
    featuredSide: "left",
    featuredPanel: "assets",
    topRowPanels: ["player", "properties"],
  },
  properties: {
    mode: "featured",
    featuredSide: "right",
    featuredPanel: "properties",
    topRowPanels: ["assets", "player"],
  },
  vertical: {
    mode: "featured",
    featuredSide: "right",
    featuredPanel: "player",
    topRowPanels: ["assets", "properties"],
  },
};

// ─── Default sizes ────────────────────────────────────────────────────────────

export const DEFAULT_SIZES_EQUAL: LayoutSizesEqual = {
  timelineH: 0.30,
  assetsW: 0.25,
  propsW: 0.25,
};

export const DEFAULT_SIZES_FEATURED: LayoutSizesFeatured = {
  timelineH: 0.30,
  featuredW: 0.25,
  topSplitW: 0.50,
};

/** Default sizes per preset. Applied when the project has no stored value for a preset. */
export const DEFAULT_SIZES: Record<LayoutPreset, LayoutSizesEqual | LayoutSizesFeatured> = {
  timeline: DEFAULT_SIZES_EQUAL,
  assets: { ...DEFAULT_SIZES_FEATURED },
  properties: { ...DEFAULT_SIZES_FEATURED },
  vertical: { timelineH: 0.30, featuredW: 0.40, topSplitW: 0.50 },
};

// ─── Label + icon (used by preset buttons in header) ─────────────────────────

export interface PresetMeta {
  label: string;
  /** Lucide icon name */
  icon: string;
}

export const PRESET_META: Record<LayoutPreset, PresetMeta> = {
  timeline: { label: "Timeline", icon: "LayoutPanelTop" },
  assets:   { label: "Assets",   icon: "PanelLeftOpen" },
  properties: { label: "Properties", icon: "PanelRightOpen" },
  vertical: { label: "Vertical",  icon: "LayoutPanelLeft" },
};
