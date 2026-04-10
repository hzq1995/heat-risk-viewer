import type { ViewerMetadata, ViewerMode } from "./types";

export type GridTransform = [number, number, number, number, number, number];

export function rowColFromLngLat(
  lng: number,
  lat: number,
  transform: GridTransform,
): { row: number; col: number } {
  const [a, b, c, d, e, f] = transform;
  const det = a * e - b * d;
  if (det === 0) {
    throw new Error("Invalid raster transform");
  }
  const col = (e * (lng - c) - b * (lat - f)) / det;
  const row = (-d * (lng - c) + a * (lat - f)) / det;
  return { row: Math.floor(row), col: Math.floor(col) };
}

export function insideRaster(row: number, col: number, width: number, height: number): boolean {
  return row >= 0 && col >= 0 && row < height && col < width;
}

export function hazardDaysForThreshold(bins: number[], threshold: number): number {
  return bins.reduce((total, value, index) => total + (index >= threshold ? value : 0), 0);
}

export function resolveTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function modeTileUrl(metadata: ViewerMetadata, mode: ViewerMode, threshold: number): string {
  return `/data/${resolveTemplate(metadata.modes[mode].tilesPathTemplate, {
    threshold,
    z: "{z}",
    x: "{x}",
    y: "{y}",
  })}`;
}

export function hazardPixelChunkUrl(metadata: ViewerMetadata, chunkRow: number, chunkCol: number): string {
  return `/data/${resolveTemplate(metadata.modes.hazard.pixelQuery.pathTemplate, {
    row: chunkRow,
    col: chunkCol,
  })}`;
}

export function riskPixelChunkUrl(metadata: ViewerMetadata, threshold: number, chunkRow: number, chunkCol: number): string {
  return `/data/${resolveTemplate(metadata.modes.heatRisk.pixelQuery.pathTemplate, {
    threshold,
    row: chunkRow,
    col: chunkCol,
  })}`;
}

export function lngLatFromRasterCell(
  row: number,
  col: number,
  transform: GridTransform,
): { lng: number; lat: number } {
  const [a, b, c, d, e, f] = transform;
  return {
    lng: a * col + b * row + c,
    lat: d * col + e * row + f,
  };
}

export function pixelGeometry(
  row: number,
  col: number,
  transform: GridTransform,
): {
  center: [number, number];
  polygon: [number, number][];
} {
  const topLeft = lngLatFromRasterCell(row, col, transform);
  const topRight = lngLatFromRasterCell(row, col + 1, transform);
  const bottomRight = lngLatFromRasterCell(row + 1, col + 1, transform);
  const bottomLeft = lngLatFromRasterCell(row + 1, col, transform);
  const center = lngLatFromRasterCell(row + 0.5, col + 0.5, transform);

  return {
    center: [center.lng, center.lat],
    polygon: [
      [topLeft.lng, topLeft.lat],
      [topRight.lng, topRight.lat],
      [bottomRight.lng, bottomRight.lat],
      [bottomLeft.lng, bottomLeft.lat],
      [topLeft.lng, topLeft.lat],
    ],
  };
}
