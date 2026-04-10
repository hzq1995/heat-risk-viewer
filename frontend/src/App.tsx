import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { DistributionChart } from "./components/DistributionChart";
import { HazardLegend } from "./components/HazardLegend";
import { HeatRiskDetailPanel } from "./components/HeatRiskDetailPanel";
import { StatsPanel } from "./components/StatsPanel";
import {
  hazardDaysForThreshold,
  hazardPixelChunkUrl,
  insideRaster,
  modeTileUrl,
  pixelGeometry,
  riskPixelChunkUrl,
  rowColFromLngLat,
} from "./lib";
import type {
  HeatRiskPixelDetail,
  HazardPixelDistribution,
  ViewerMetadata,
  ViewerMode,
} from "./types";

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const PIXEL_SOURCE_ID = "selected-pixel";
const HAZARD_TARGET_OPACITY = 0.68;
const HAZARD_SWITCH_DURATION_MS = 420;

type SelectedHazardBase = Omit<HazardPixelDistribution, "hazardDays">;
type SelectedRiskLocation = Omit<HeatRiskPixelDetail, "hazard" | "population" | "vulnerability" | "heatRisk">;

function emptyPixelFeatureCollection() {
  return {
    type: "FeatureCollection" as const,
    features: [],
  };
}

function pixelFeatureCollection(
  row: number,
  col: number,
  transform: ViewerMetadata["modes"]["hazard"]["rasterGrid"]["transform"],
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

function layerIdFor(mode: ViewerMode, threshold: number): string {
  return `${mode}-layer-${threshold}`;
}

function sourceIdFor(mode: ViewerMode, threshold: number): string {
  return `${mode}-source-${threshold}`;
}

function findRasterInsertBeforeId(map: MapLibreMap): string | undefined {
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

function hideInactiveRasterLayers(
  map: MapLibreMap,
  metadata: ViewerMetadata,
  activeMode: ViewerMode,
  activeThreshold: number,
) {
  for (const mode of metadata.availableModes) {
    for (const threshold of metadata.thresholds) {
      const layerId = layerIdFor(mode, threshold);
      if (!map.getLayer(layerId)) {
        continue;
      }
      const visible = mode === activeMode && threshold === activeThreshold;
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      map.setPaintProperty(layerId, "raster-opacity", visible ? HAZARD_TARGET_OPACITY : 0);
    }
  }
}

function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const currentVisibleLayerKeyRef = useRef<string | null>(null);
  const thresholdHideTimeoutRef = useRef<number | null>(null);
  const activeModeRef = useRef<ViewerMode>("hazard");
  const activeThresholdRef = useRef(25);
  const hazardChunkCacheRef = useRef<globalThis.Map<string, Uint8Array>>(new globalThis.Map());
  const riskChunkCacheRef = useRef<globalThis.Map<string, Float32Array>>(new globalThis.Map());
  const riskRequestTokenRef = useRef(0);

  const [metadata, setMetadata] = useState<ViewerMetadata | null>(null);
  const [mode, setMode] = useState<ViewerMode>("hazard");
  const [threshold, setThreshold] = useState(25);
  const deferredThreshold = useDeferredValue(threshold);
  const [selectedHazardPixel, setSelectedHazardPixel] = useState<SelectedHazardBase | null>(null);
  const [selectedRiskLocation, setSelectedRiskLocation] = useState<SelectedRiskLocation | null>(null);
  const [selectedRiskDetail, setSelectedRiskDetail] = useState<HeatRiskPixelDetail | null>(null);
  const [statusText, setStatusText] = useState("Loading metadata...");

  activeModeRef.current = mode;
  activeThresholdRef.current = deferredThreshold;

  useEffect(() => {
    let cancelled = false;

    async function loadMetadata() {
      const response = await fetch("/data/metadata.json");
      if (!response.ok) {
        throw new Error("Failed to load metadata.json");
      }

      const payload = (await response.json()) as ViewerMetadata;
      if (cancelled) {
        return;
      }

      setMetadata(payload);
      setMode(payload.defaultMode);
      setThreshold(payload.defaultThreshold);
      setStatusText("Click the map to inspect a pixel.");
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

  async function loadHazardDistribution(
    viewerMetadata: ViewerMetadata,
    row: number,
    col: number,
    lng: number,
    lat: number,
  ) {
    const hazardMeta = viewerMetadata.modes.hazard;
    const chunkSize = hazardMeta.pixelQuery.chunkSize;
    const chunkRow = Math.floor(row / chunkSize);
    const chunkCol = Math.floor(col / chunkSize);
    const cacheKey = `${chunkRow}-${chunkCol}`;
    let buffer = hazardChunkCacheRef.current.get(cacheKey);

    if (!buffer) {
      const response = await fetch(hazardPixelChunkUrl(viewerMetadata, chunkRow, chunkCol));
      if (!response.ok) {
        throw new Error("Failed to load the hazard distribution chunk.");
      }
      buffer = new Uint8Array(await response.arrayBuffer());
      hazardChunkCacheRef.current.set(cacheKey, buffer);
    }

    const localRow = row - chunkRow * chunkSize;
    const localCol = col - chunkCol * chunkSize;
    const actualChunkWidth = Math.min(chunkSize, hazardMeta.rasterGrid.width - chunkCol * chunkSize);
    const offset = (localRow * actualChunkWidth + localCol) * hazardMeta.pixelQuery.bands;
    const bins = Array.from(buffer.slice(offset, offset + hazardMeta.pixelQuery.bands));
    const nodata = hazardMeta.rasterGrid.nodata;

    if (bins.every((value) => value === nodata)) {
      throw new Error("No valid hazard data exists at this location.");
    }

    return {
      row,
      col,
      lng,
      lat,
      bins,
    } satisfies SelectedHazardBase;
  }

  async function loadRiskDetail(
    viewerMetadata: ViewerMetadata,
    row: number,
    col: number,
    lng: number,
    lat: number,
    targetThreshold: number,
  ) {
    const token = riskRequestTokenRef.current + 1;
    riskRequestTokenRef.current = token;

    const riskMeta = viewerMetadata.modes.heatRisk;
    const chunkSize = riskMeta.pixelQuery.chunkSize;
    const chunkRow = Math.floor(row / chunkSize);
    const chunkCol = Math.floor(col / chunkSize);
    const cacheKey = `${targetThreshold}-${chunkRow}-${chunkCol}`;
    let buffer = riskChunkCacheRef.current.get(cacheKey);

    if (!buffer) {
      const response = await fetch(riskPixelChunkUrl(viewerMetadata, targetThreshold, chunkRow, chunkCol));
      if (!response.ok) {
        throw new Error("Failed to load the heat risk detail chunk.");
      }
      buffer = new Float32Array(await response.arrayBuffer());
      riskChunkCacheRef.current.set(cacheKey, buffer);
    }

    const localRow = row - chunkRow * chunkSize;
    const localCol = col - chunkCol * chunkSize;
    const actualChunkWidth = Math.min(chunkSize, riskMeta.rasterGrid.width - chunkCol * chunkSize);
    const fieldsPerPixel = riskMeta.pixelQuery.fields.length;
    const offset = (localRow * actualChunkWidth + localCol) * fieldsPerPixel;
    const values = Array.from(buffer.slice(offset, offset + fieldsPerPixel));
    const [hazard, population, vulnerability, heatRisk] = values;

    if (token !== riskRequestTokenRef.current) {
      return null;
    }

    if (heatRisk === riskMeta.rasterGrid.nodata) {
      throw new Error("No valid heat risk data exists at this location.");
    }

    return {
      row,
      col,
      lng,
      lat,
      hazard,
      population,
      vulnerability,
      heatRisk,
    } satisfies HeatRiskPixelDetail;
  }

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
      minZoom: metadata.modes.hazard.zoomRange.min,
      maxZoom: Math.max(metadata.modes.hazard.zoomRange.max, metadata.modes.heatRisk.zoomRange.max) + 1,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: false }), "top-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      const insertBeforeId = findRasterInsertBeforeId(map);

      for (const availableMode of metadata.availableModes) {
        const modeMetadata = metadata.modes[availableMode];
        for (const thresholdValue of metadata.thresholds) {
          map.addSource(sourceIdFor(availableMode, thresholdValue), {
            type: "raster",
            tiles: [modeTileUrl(metadata, availableMode, thresholdValue)],
            tileSize: modeMetadata.tileSize,
            bounds: modeMetadata.bounds,
            minzoom: modeMetadata.zoomRange.min,
            maxzoom: modeMetadata.zoomRange.max,
          });

          const isInitiallyVisible =
            availableMode === metadata.defaultMode && thresholdValue === metadata.defaultThreshold;

          map.addLayer(
            {
              id: layerIdFor(availableMode, thresholdValue),
              type: "raster",
              source: sourceIdFor(availableMode, thresholdValue),
              layout: {
                visibility: isInitiallyVisible ? "visible" : "none",
              },
              paint: {
                "raster-opacity": isInitiallyVisible ? HAZARD_TARGET_OPACITY : 0,
                "raster-resampling": "linear",
                "raster-fade-duration": 0,
                "raster-opacity-transition": {
                  duration: HAZARD_SWITCH_DURATION_MS,
                  delay: 0,
                },
              },
            },
            insertBeforeId,
          );
        }
      }

      currentVisibleLayerKeyRef.current = `${metadata.defaultMode}:${metadata.defaultThreshold}`;

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
      const currentMode = activeModeRef.current;
      const currentThreshold = activeThresholdRef.current;
      const lng = event.lngLat.lng;
      const lat = event.lngLat.lat;

      try {
        if (currentMode === "hazard") {
          const hazardGrid = metadata.modes.hazard.rasterGrid;
          const { row, col } = rowColFromLngLat(lng, lat, hazardGrid.transform);
          if (!insideRaster(row, col, hazardGrid.width, hazardGrid.height)) {
            throw new Error("The clicked location is outside the hazard raster extent.");
          }
          setStatusText("Loading hazard distribution...");
          const distribution = await loadHazardDistribution(metadata, row, col, lng, lat);
          setSelectedHazardPixel(distribution);
          setStatusText("Click another location to inspect a different hazard pixel.");
          return;
        }

        const riskGrid = metadata.modes.heatRisk.rasterGrid;
        const { row, col } = rowColFromLngLat(lng, lat, riskGrid.transform);
        if (!insideRaster(row, col, riskGrid.width, riskGrid.height)) {
          throw new Error("The clicked location is outside the heat risk raster extent.");
        }
        setStatusText("Loading heat risk detail...");
        const detail = await loadRiskDetail(metadata, row, col, lng, lat, currentThreshold);
        if (!detail) {
          return;
        }
        setSelectedRiskLocation({ row, col, lng, lat });
        setSelectedRiskDetail(detail);
        setStatusText("Click another location to inspect a different heat risk cell.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to inspect the selected pixel.";
        setStatusText(message);
        if (currentMode === "hazard") {
          setSelectedHazardPixel(null);
        } else {
          setSelectedRiskLocation(null);
          setSelectedRiskDetail(null);
        }
      }
    });

    mapRef.current = map;

    return () => {
      if (thresholdHideTimeoutRef.current !== null) {
        window.clearTimeout(thresholdHideTimeoutRef.current);
      }
      map.remove();
      mapRef.current = null;
      currentVisibleLayerKeyRef.current = null;
    };
  }, [metadata]);

  useEffect(() => {
    if (!metadata) {
      return;
    }
    if (mode === "hazard" && !selectedHazardPixel) {
      setStatusText("Click the map to inspect a hazard pixel.");
    }
    if (mode === "heatRisk" && !selectedRiskLocation) {
      setStatusText("Click the map to inspect a heat risk cell.");
    }
  }, [metadata, mode, selectedHazardPixel, selectedRiskLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !metadata) {
      return;
    }

    const nextLayerKey = `${mode}:${deferredThreshold}`;
    const previousLayerKey = currentVisibleLayerKeyRef.current;

    if (thresholdHideTimeoutRef.current !== null) {
      window.clearTimeout(thresholdHideTimeoutRef.current);
      thresholdHideTimeoutRef.current = null;
    }

    const nextLayer = layerIdFor(mode, deferredThreshold);
    if (!map.getLayer(nextLayer)) {
      return;
    }

    if (previousLayerKey === nextLayerKey) {
      return;
    }

    map.setLayoutProperty(nextLayer, "visibility", "visible");
    map.setPaintProperty(nextLayer, "raster-opacity", HAZARD_TARGET_OPACITY);

    if (previousLayerKey) {
      const [previousMode, previousThreshold] = previousLayerKey.split(":");
      const previousLayer = layerIdFor(previousMode as ViewerMode, Number(previousThreshold));
      if (map.getLayer(previousLayer)) {
        map.setLayoutProperty(previousLayer, "visibility", "visible");
        map.setPaintProperty(previousLayer, "raster-opacity", 0);
      }
    }

    currentVisibleLayerKeyRef.current = nextLayerKey;
    thresholdHideTimeoutRef.current = window.setTimeout(() => {
      hideInactiveRasterLayers(map, metadata, mode, deferredThreshold);
      thresholdHideTimeoutRef.current = null;
    }, HAZARD_SWITCH_DURATION_MS + 120);
  }, [deferredThreshold, metadata, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !metadata) {
      return;
    }

    const source = map.getSource(PIXEL_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) {
      return;
    }

    if (mode === "hazard" && selectedHazardPixel) {
      source.setData(pixelFeatureCollection(selectedHazardPixel.row, selectedHazardPixel.col, metadata.modes.hazard.rasterGrid.transform));
      return;
    }

    if (mode === "heatRisk" && selectedRiskLocation) {
      source.setData(pixelFeatureCollection(selectedRiskLocation.row, selectedRiskLocation.col, metadata.modes.heatRisk.rasterGrid.transform));
      return;
    }

    source.setData(emptyPixelFeatureCollection());
  }, [metadata, mode, selectedHazardPixel, selectedRiskLocation]);

  useEffect(() => {
    if (!metadata || !selectedRiskLocation) {
      return;
    }

    const viewerMetadata = metadata;
    const riskLocation = selectedRiskLocation;
    let cancelled = false;

    async function refreshRiskDetail() {
      try {
        const detail = await loadRiskDetail(
          viewerMetadata,
          riskLocation.row,
          riskLocation.col,
          riskLocation.lng,
          riskLocation.lat,
          deferredThreshold,
        );
        if (!cancelled && detail) {
          setSelectedRiskDetail(detail);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Failed to refresh heat risk detail.";
          setStatusText(message);
          setSelectedRiskDetail(null);
        }
      }
    }

    refreshRiskDetail();

    return () => {
      cancelled = true;
    };
  }, [deferredThreshold, metadata, selectedRiskLocation]);

  const currentModeMetadata = useMemo(() => (metadata ? metadata.modes[mode] : null), [metadata, mode]);

  const currentStats = useMemo(() => {
    if (!currentModeMetadata) {
      return null;
    }
    return currentModeMetadata.statsByThreshold[String(deferredThreshold)];
  }, [currentModeMetadata, deferredThreshold]);

  const displayedHazardPixel = useMemo<HazardPixelDistribution | null>(() => {
    if (!selectedHazardPixel) {
      return null;
    }
    return {
      ...selectedHazardPixel,
      hazardDays: hazardDaysForThreshold(selectedHazardPixel.bins, deferredThreshold),
    };
  }, [deferredThreshold, selectedHazardPixel]);

  if (!metadata || !currentModeMetadata) {
    return <div className="loading-shell">{statusText}</div>;
  }

  return (
    <div className="app-shell">
      <main className="viewer-layout">
        <section className="map-stage">
          <div className="map-header">
            <div>
              <p className="eyebrow">Heat Threshold Explorer</p>
              <h1>{metadata.cityLabel} hazard and risk viewer</h1>
            </div>
            <div className="map-meta">
              <span>{mode === "hazard" ? metadata.rawDataPaths.hazard : metadata.rawDataPaths.populationNairobi}</span>
              <span>{currentModeMetadata.generated.tilesWritten.toLocaleString("en-US")} tiles generated</span>
            </div>
          </div>
          <div ref={mapContainerRef} className="map-canvas" />
        </section>

        <aside className="control-panel">
          <section className="panel-block panel-hero">
            <p className="eyebrow">Viewer</p>
            <h2>{mode === "hazard" ? "Hazard mode" : "Heat risk mode"}</h2>
            <div className="mode-toggle" role="tablist" aria-label="Viewer mode">
              <button
                type="button"
                className={mode === "hazard" ? "mode-toggle-button active" : "mode-toggle-button"}
                onClick={() => setMode("hazard")}
              >
                Hazard
              </button>
              <button
                type="button"
                className={mode === "heatRisk" ? "mode-toggle-button active" : "mode-toggle-button"}
                onClick={() => setMode("heatRisk")}
              >
                Heat Risk
              </button>
            </div>
            <p className="panel-copy">
              {mode === "hazard"
                ? metadata.modes.hazard.definition
                : metadata.modes.heatRisk.formula}
            </p>
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

          {currentStats ? (
            <StatsPanel
              title={mode === "hazard" ? "Hazard summary" : "Heat risk summary"}
              subtitle={mode === "hazard" ? "Valid hazard pixels" : "Valid 100m risk cells"}
              stats={currentStats}
            />
          ) : null}

          <HazardLegend
            title={mode === "hazard" ? "Hazard legend" : "Heat risk legend"}
            unitLabel={mode === "hazard" ? "days" : "risk"}
            domain={currentModeMetadata.legendDomain}
            stops={currentModeMetadata.legendStops}
          />

          {mode === "hazard" ? (
            displayedHazardPixel ? (
              <DistributionChart
                distribution={displayedHazardPixel}
                threshold={deferredThreshold}
                labels={metadata.modes.hazard.binLabels}
              />
            ) : (
              <section className="panel-block empty-state">
                <div className="panel-heading">
                  <span>Hazard pixel detail</span>
                  <small>Single click</small>
                </div>
                <p>{statusText}</p>
              </section>
            )
          ) : selectedRiskDetail ? (
            <HeatRiskDetailPanel detail={selectedRiskDetail} threshold={deferredThreshold} />
          ) : (
            <section className="panel-block empty-state">
              <div className="panel-heading">
                <span>Heat risk detail</span>
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
