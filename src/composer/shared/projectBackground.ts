export const DEFAULT_PROJECT_BACKGROUND_COLOR = "#000000";

export function normalizeProjectBackgroundColor(
  backgroundColor: string | null | undefined,
): string {
  return /^#[0-9a-f]{6}$/i.test(backgroundColor ?? "")
    ? backgroundColor!.toLowerCase()
    : DEFAULT_PROJECT_BACKGROUND_COLOR;
}
