export type InstanceGhostTrackType = "video" | "audio";

export interface InstanceDragGhostModel {
  label: string;
  detail: string;
  trackType: InstanceGhostTrackType;
  width: number;
}

export const INSTANCE_DRAG_GHOST_HEIGHT = 44;
export const INSTANCE_DRAG_GHOST_MIN_WIDTH = 18;

function getGhostPalette(trackType: InstanceGhostTrackType) {
  return trackType === "audio"
    ? {
        background: "rgba(16, 185, 129, 0.78)",
        border: "rgba(167, 243, 208, 0.95)",
      }
    : {
        background: "rgba(14, 165, 233, 0.78)",
        border: "rgba(186, 230, 253, 0.95)",
      };
}

export function getInstanceGhostWidth(duration: number, zoom: number): number {
  return Math.max(Math.round(duration * zoom), INSTANCE_DRAG_GHOST_MIN_WIDTH);
}

export function createInstanceDragImage(
  dataTransfer: DataTransfer,
  model: InstanceDragGhostModel,
): void {
  const palette = getGhostPalette(model.trackType);
  const element = document.createElement("div");
  element.style.position = "fixed";
  element.style.left = "-10000px";
  element.style.top = "-10000px";
  element.style.width = `${Math.max(model.width, INSTANCE_DRAG_GHOST_MIN_WIDTH)}px`;
  element.style.height = `${INSTANCE_DRAG_GHOST_HEIGHT}px`;
  element.style.display = "flex";
  element.style.alignItems = "stretch";
  element.style.overflow = "hidden";
  element.style.borderRadius = "6px";
  element.style.border = `1px solid ${palette.border}`;
  element.style.background = palette.background;
  element.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.35)";
  element.style.color = "#ffffff";
  element.style.fontFamily =
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  element.style.pointerEvents = "none";
  element.style.zIndex = "2147483647";

  const leftHandle = document.createElement("div");
  leftHandle.style.width = "8px";
  leftHandle.style.flexShrink = "0";
  leftHandle.style.background = "rgba(0, 0, 0, 0.22)";

  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.minWidth = "0";
  body.style.flex = "1";
  body.style.flexDirection = "column";
  body.style.justifyContent = "center";
  body.style.padding = "0 8px";

  const title = document.createElement("div");
  title.textContent = model.label;
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  title.style.fontSize = "12px";
  title.style.fontWeight = "600";
  title.style.lineHeight = "16px";

  const detail = document.createElement("div");
  detail.textContent = model.detail;
  detail.style.overflow = "hidden";
  detail.style.textOverflow = "ellipsis";
  detail.style.whiteSpace = "nowrap";
  detail.style.fontSize = "10px";
  detail.style.lineHeight = "14px";
  detail.style.color = "rgba(255, 255, 255, 0.82)";

  const rightHandle = document.createElement("div");
  rightHandle.style.width = "8px";
  rightHandle.style.flexShrink = "0";
  rightHandle.style.background = "rgba(0, 0, 0, 0.22)";

  body.append(title, detail);
  element.append(leftHandle, body, rightHandle);
  document.body.appendChild(element);
  dataTransfer.setDragImage(element, 12, 22);

  requestAnimationFrame(() => {
    element.remove();
  });
}

export function getInstanceGhostStyle(
  model: InstanceDragGhostModel,
): Record<string, string | number> {
  const palette = getGhostPalette(model.trackType);
  return {
    width: `${Math.max(model.width, INSTANCE_DRAG_GHOST_MIN_WIDTH)}px`,
    height: `${INSTANCE_DRAG_GHOST_HEIGHT}px`,
    borderRadius: "6px",
    border: `1px solid ${palette.border}`,
    background: palette.background,
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35)",
    color: "#ffffff",
  };
}
