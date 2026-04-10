export type ThresholdStats = {
  min: number;
  max: number;
  mean: number;
  p90: number;
};

export type PixelChunksMetadata = {
  pathTemplate: string;
  chunkSize: number;
  bands: number;
  interleave: "pixel";
  chunk_rows: number;
  chunk_cols: number;
  chunk_count: number;
};

export type HazardMetadata = {
  cityKey: string;
  cityLabel: string;
  thresholdModeLabel: string;
  hazardDefinition: string;
  units: {
    temperature: string;
    hazard: string;
  };
  sourceFile: string;
  tileSize: number;
  zoomRange: {
    min: number;
    max: number;
  };
  bounds: [number, number, number, number];
  thresholds: number[];
  legendDomain: [number, number];
  legendStops: Array<{
    value: number;
    color: string;
  }>;
  binEdges: number[];
  binLabels: string[];
  rasterShape: {
    width: number;
    height: number;
  };
  transform: [number, number, number, number, number, number];
  crs: string;
  nodata: number;
  pixelChunks: PixelChunksMetadata;
  statsByThreshold: Record<string, ThresholdStats>;
  generated: {
    thresholdCount: number;
    tilesWritten: number;
  };
};

export type PixelDistribution = {
  row: number;
  col: number;
  lng: number;
  lat: number;
  bins: number[];
  hazardDays: number;
};
