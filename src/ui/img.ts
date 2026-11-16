/**
 * Box attributes for a lazy <img> that draws a member's file.
 *
 * A lazy image with no reserved box starts at 0x0 and expands when its bytes land, which
 * pushes whatever is around it. The picture's natural width and height give it a box before
 * the request starts; `object-cover` still crops it to whatever the container says, so nothing
 * looks different once the bytes land.
 *
 * Returns {} when the size is unknown, so a tile whose record carries no dimensions renders
 * exactly as before instead of inventing one.
 */
export function imgBox(dims: { width?: number | null; height?: number | null } | null | undefined): {
  width?: number;
  height?: number;
} {
  const w = dims?.width ?? null;
  const h = dims?.height ?? null;
  if (!w || !h) return {};
  return { width: w, height: h };
}
