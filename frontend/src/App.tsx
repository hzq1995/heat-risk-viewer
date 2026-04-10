import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { DistributionChart } from "./components/DistributionChart";
import { HazardLegend } from "./components/HazardLegend";
import { StatsPanel } from "./components/StatsPanel";
import { hazardDaysForThreshold, insideRaster, pixelChunkUrl, pixelGeometry, rowColFromLngLat } from "./lib";
import type { HazardMetadata, PixelDistribution } from "./types";

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const PIXEL_SOURCE_ID = "selected-pixel";
const HAZARD_LAYER_PREFIX = "hazard-layer-";
const HAZARD_SOURCE_PREFIX = "hazard-source-";
const HAZARD_TARGET_OPACITY = 0.68;
const HAZARD_SWITCH_DURATION_MS = 420;

type SelectedPixelBase = Omit<PixelDistribution, "hazardDays">;

function emptyPixelFeatureCollection() {
  return {
    type: "FeatureCollection" as const,
    features: [],
  };
}

function pixelFeatureCollection(
  row: number,
  col: number,
  transform: HazardMetadata["transform"],
) {
  const geometry = pixelGeometry(row, col, transform);
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { kind: "pixel" },
        geometry: {
          type: "Polygon" as const,
          coordinates: [geometry.polygon],
        },
      },
      {
        type: "Feature" as const,
        properties: { kind: "center" },
        geometry: {
          type: "Point" as const,
          coordinates: geometry.center,
        },
      },
    ],
  };
}

function layerIdForThreshold(threshold: number): string {
  return `${HAZARD_LAYER_PREFIX}${threshold}`;
}

function sourceIdForThreshold(threshold: number): string {
  return `${HAZARD_SOURCE_PREFIX}${threshold}`;
}

function findHazardInsertBeforeId(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers ?? [];
  const preferredLayer = layers.find((layer) => {
    const id = layer.id.toLowerCase();
    return layer.type === "line" && /boundary|admin|place|label/.test(id);
  });
  if (preferredLayer) {
    return preferredLayer.id;
  }
  return layers.find((layer) => layer.type === "symbol")?.id;
}

function hideInactiveHazardLayers(map: MapLibreMap, thresholds: number[], activeThreshold: number) {
  for (const threshold of thresholds) {
    const layerId = layerIdForThreshold(threshold);
    if (!map.getLayer(layerId)) {
      continue;
    }
    if (threshold === activeThreshold) {
      map.setLayoutProperty(layerId, "visibility", "visible");
      map.setPaintProperty(layerId, "raster-opacity", HAZARD_TARGET_OPACITY);
      continue;
    }
    map.setLayoutProperty(layerId, "visibility", "none");
    map.setPaintProperty(layerId, "raster-opacity", 0);
  }
}

function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const currentVisibleThresholdRef = useRef<number | null>(null);
  const thresholdHideTimeoutRef = useRef<number | null>(null);
  const [metadata, setMetadata] = useState<HazardMetadata | null>(null);
  const [threshold, setThreshold] = useState(25);
  const deferredThreshold = useDeferredValue(threshold);
  const [selectedPixel, setSelectedPixel] = useState<SelectedPixelBase | null>(null);
  const [statusText, setStatusText] = useState("Loading metadata...");
  const chunkCacheRef = useRef<globalThis.Map<string, Uint8Array>>(new globalThis.Map());

  useEffect(() => {
    let cancelled = false;

    async function loadMetadata() {
      const response = await fetch("/data/metadata.json");
      if (!response.ok) {
        throw new Error("Failed to load metadata.json");
      }

      const payload = (await response.json()) as HazardMetadata;
      if (cancelled) {
        return;
      }

      setMetadata(payload);
      const preferredThreshold = payload.thresholds.includes(25)
        ? 25
        : payload.thresholds[Math.floor(payload.thresholds.length / 2)];
      setThreshold(preferredThreshold);
      setStatusText("Click the map to inspect a pixel distribution.");
    }

    loadMetadata().catch((error: Error) => {
      if (!cancelled) {
        setStatusText(error.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!metadata || !mapContainerRef.current || mapRef.current) {
      return;
    }

    const bounds = metadata.bounds as LngLatBoundsLike;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: BASEMAP_STYLE,
      bounds,
      fitBoundsOptions: { padding: 36 },
      maxBounds: bounds,
      minZoom: metadata.zoomRange.min,
      maxZoom: metadata.zoomRange.max + 1,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: false }), "top-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      const insertBeforeId = findHazardInsertBeforeId(map);
      for (const thresholdValue of metadata.thresholds) {
        map.addSource(sourceIdForThreshold(thresholdValue), {
          type: "raster",
          tiles: [`/data/tiles/${thresholdValue}/{z}/{x}/{y}.png`],
          tileSize: metadata.tileSize,
          bounds: metadata.bounds,
          minzoom: metadata.zoomRange.min,
          maxzoom: metadata.zoomRange.max,
        });

        map.addLayer({
          id: layerIdForThreshold(thresholdValue),
          type: "raster",
          source: sourceIdForThreshold(thresholdValue),
          layout: {
            visibility: thresholdValue === deferredThreshold ? "visible" : "none",
          },
          paint: {
            "raster-opacity": thresholdValue === deferredThreshold ? HAZARD_TARGET_OPACITY : 0,
            "raster-resampling": "linear",
            "raster-fade-duration": 0,
            "raster-opacity-transition": {
              duration: HAZARD_SWITCH_DURATION_MS,
              delay: 0,
            },
          },
        }, insertBeforeId);
      }

      currentVisibleThresholdRef.current = deferredThreshold;

      map.addSource(PIXEL_SOURCE_ID, {
        type: "geojson",
        data: emptyPixelFeatureCollection(),
      });

      map.addLayer({
        id: "selected-pixel-fill",
        type: "fill",
        source: PIXEL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "pixel"],
        paint: {
          "fill-color": "#2f80ed",
          "fill-opacity": 0.12,
        },
      });

      map.addLayer({
        id: "selected-pixel-outline",
        type: "line",
        source: PIXEL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "pixel"],
        paint: {
          "line-color": "#165dff",
          "line-width": 2,
          "line-opacity": 0.95,
        },
      });

      map.addLayer({
        id: "selected-pixel-center",
        type: "circle",
        source: PIXEL_SOURCE_ID,
        filter: ["==", ["get", "kind"], "center"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#165dff",
        },
      });

      map.once("idle", () => {
        map.setMinZoom(map.getZoom());
      });
    });

    map.on("click", async (event) => {
      const lng = event.lngLat.lng;
      const lat = event.lngLat.lat;
      const { row, col } = rowColFromLngLat(lng, lat, metadata.transform);

      if (!insideRaster(row, col, metadata.rasterShape.width, metadata.rasterShape.height)) {
        setSelectedPixel(null);
        setStatusText("The clicked location is outside the raster extent.");
        const source = map.getSource(PIXEL_SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData(emptyPixelFeatureCollection());
        return;
      }

      setStatusText("Loading pixel distribution...");
      const chunkSize = metadata.pixelChunks.chunkSize;
      const chunkRow = Math.floor(row / chunkSize);
      const chunkCol = Math.floor(col / chunkSize);
      const cacheKey = `${chunkRow}-${chunkCol}`;
      let buffer = chunkCacheRef.current.get(cacheKey);

      if (!buffer) {
        const response = await fetch(pixelChunkUrl(metadata, chunkRow, chunkCol));
        if (!response.ok) {
          setStatusText("Failed to load the pixel distribution chunk.");
          return;
        }
        buffer = new Uint8Array(await response.arrayBuffer());
        chunkCacheRef.current.set(cacheKey, buffer);
      }

      const localRow = row - chunkRow * chunkSize;
      const localCol = col - chunkCol * chunkSize;
      const actualChunkWidth = Math.min(chunkSize, metadata.rasterShape.width - chunkCol * chunkSize);
      const offset = (localRow * actualChunkWidth + localCol) * metadata.pixelChunks.bands;
      const bins = Array.from(buffer.slice(offset, offset + metadata.pixelChunks.bands));

      if (bins.every((value) => value === metadata.nodata)) {
        setSelectedPixel(null);
        setStatusText("No valid data exists at this location.");
        const source = map.getSource(PIXEL_SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData(emptyPixelFeatureCollection());
        return;
      }

      setSelectedPixel({
        row,
        col,
        lng,
        lat,
        bins,
      });

      const source = map.getSource(PIXEL_SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(pixelFeatureCollection(row, col, metadata.transform));
      setStatusText("Click another location to inspect a different pixel.");
    });

    mapRef.current = map;

    return () => {
      if (thresholdHideTimeoutRef.current !== null) {
        window.clearTimeout(thresholdHideTimeoutRef.current);
      }
      map.remove();
      mapRef.current = null;
      currentVisibleThresholdRef.current = null;
    };
  }, [metadata]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    const nextThreshold = deferredThreshold;
    const previousThreshold = currentVisibleThresholdRef.current;
    const nextLayer = layerIdForThreshold(nextThreshold);
    if (!map.getLayer(nextLayer)) {
      return;
    }

    if (thresholdHideTimeoutRef.current !== null) {
      window.clearTimeout(thresholdHideTimeoutRef.current);
      thresholdHideTimeoutRef.current = null;
    }

    if (previousThreshold === null) {
      map.setLayoutProperty(nextLayer, "visibility", "visible");
      map.setPaintProperty(nextLayer, "raster-opacity", HAZARD_TARGET_OPACITY);
      currentVisibleThresholdRef.current = nextThreshold;
      return;
    }

    if (previousThreshold === nextThreshold) {
      return;
    }

    const previousLayer = layerIdForThreshold(previousThreshold);

    map.setLayoutProperty(nextLayer, "visibility", "visible");
    map.setPaintProperty(nextLayer, "raster-opacity", HAZARD_TARGET_OPACITY);
    if (map.getLayer(previousLayer)) {
      map.setLayoutProperty(previousLayer, "visibility", "visible");
      map.setPaintProperty(previousLayer, "raster-opacity", 0);
    }

    currentVisibleThresholdRef.current = nextThreshold;

    thresholdHideTimeoutRef.current = window.setTimeout(() => {
      hideInactiveHazardLayers(map, metadata?.thresholds ?? [], nextThreshold);
      thresholdHideTimeoutRef.current = null;
    }, HAZARD_SWITCH_DURATION_MS + 120);
  }, [deferredThreshold, metadata]);

  const currentStats = useMemo(() => {
    if (!metadata) {
      return null;
    }
    return metadata.statsByThreshold[String(deferredThreshold)];
  }, [deferredThreshold, metadata]);

  const displayedPixel = useMemo<PixelDistribution | null>(() => {
    if (!selectedPixel) {
      return null;
    }
    return {
      ...selectedPixel,
      hazardDays: hazardDaysForThreshold(selectedPixel.bins, deferredThreshold),
    };
  }, [deferredThreshold, selectedPixel]);

  if (!metadata) {
    return <div className="loading-shell">{statusText}</div>;
  }

  return (
    <div className="app-shell">
      <main className="viewer-layout">
        <section className="map-stage">
          <div className="map-header">
            <div>
              <p className="eyebrow">Heat Threshold Explorer</p>
              <h1>{metadata.cityLabel} hazard viewer</h1>
            </div>
            <div className="map-meta">
              <span>{metadata.sourceFile}</span>
              <span>{metadata.generated.tilesWritten.toLocaleString("en-US")} tiles generated</span>
            </div>
          </div>
          <div ref={mapContainerRef} className="map-canvas" />
        </section>

        <aside className="control-panel">
          <section className="panel-block panel-hero">
            <p className="eyebrow">Threshold</p>
            <h2>Hazard definition</h2>
            <p className="panel-copy">Hazard days are computed from temperature bins whose lower edge is greater than or equal to the active threshold.</p>
            <label className="threshold-slider">
              <span>Temperature threshold</span>
              <strong>{threshold}°C</strong>
              <input
                type="range"
                min={metadata.thresholds[0]}
                max={metadata.thresholds[metadata.thresholds.length - 1]}
                step={1}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
            </label>
            <div className="threshold-footnote">
              <span>0°C</span>
              <span>50°C</span>
            </div>
          </section>

          {currentStats ? <StatsPanel stats={currentStats} /> : null}
          <HazardLegend metadata={metadata} />

          {displayedPixel ? (
            <DistributionChart distribution={displayedPixel} threshold={deferredThreshold} labels={metadata.binLabels} />
          ) : (
            <section className="panel-block empty-state">
              <div className="panel-heading">
                <span>Pixel inspection</span>
                <small>Single click</small>
              </div>
              <p>{statusText}</p>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}

export default App;
