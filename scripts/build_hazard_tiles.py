from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import mercantile
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import Affine, from_bounds
from rasterio.warp import reproject
from rasterio.windows import Window


TILE_SIZE = 256
CHUNK_SIZE = 128
ZOOM_MIN = 8
ZOOM_MAX = 14
NODATA_U8 = 255
HAZARD_NODATA = -1.0
RISK_NODATA = -9999.0
RISK_FIELD_NAMES = ["hazard", "population", "vulnerability", "heatRisk"]

COLOR_STOPS = [
    (0.0, (245, 242, 230)),
    (0.12, (240, 206, 134)),
    (0.32, (236, 149, 75)),
    (0.58, (210, 78, 57)),
    (0.8, (137, 32, 55)),
    (1.0, (48, 12, 39)),
]


def build_palette(max_value: int) -> np.ndarray:
    palette = np.zeros((max_value + 1, 4), dtype=np.uint8)
    stop_positions = np.array([stop[0] for stop in COLOR_STOPS], dtype=np.float32)
    stop_colors = np.array([stop[1] for stop in COLOR_STOPS], dtype=np.float32)
    values = np.linspace(0.0, 1.0, max_value + 1, dtype=np.float32)
    for channel in range(3):
        palette[:, channel] = np.interp(values, stop_positions, stop_colors[:, channel]).round().astype(np.uint8)
    palette[:, 3] = 255
    return palette


def affine_to_list(transform: Affine) -> list[float]:
    return [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]


def distribution_is_nodata(distribution: np.ndarray, nodata: int = NODATA_U8) -> bool:
    return bool(np.all(distribution == nodata))


def compute_hazard_cube(counts: np.ndarray) -> np.ndarray:
    if counts.ndim != 3:
        raise ValueError("counts must have shape (bands, rows, cols)")
    bands, rows, cols = counts.shape
    cube = np.zeros((bands + 1, rows, cols), dtype=np.uint16)
    running = np.zeros((rows, cols), dtype=np.uint16)
    for threshold in range(bands - 1, -1, -1):
        running = running + counts[threshold].astype(np.uint16)
        cube[threshold] = running
    return cube


def tile_bounds_mercator(tile: mercantile.Tile) -> tuple[float, float, float, float]:
    bounds = mercantile.xy_bounds(tile)
    return bounds.left, bounds.bottom, bounds.right, bounds.top


def colorize_tile(tile_data: np.ndarray, palette: np.ndarray, nodata: float, max_value: float) -> np.ndarray:
    rgba = np.zeros((tile_data.shape[0], tile_data.shape[1], 4), dtype=np.uint8)
    valid = tile_data != nodata
    if not np.any(valid):
        return rgba
    scaled = np.clip(np.rint(tile_data[valid]), 0, max_value).astype(np.int32)
    rgba[valid] = palette[scaled]
    return rgba


def save_rgba_png(path: Path, rgba: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(path)


def chunk_summary(width: int, height: int, chunk_size: int) -> dict[str, int]:
    chunk_rows = math.ceil(height / chunk_size)
    chunk_cols = math.ceil(width / chunk_size)
    return {
        "chunk_rows": chunk_rows,
        "chunk_cols": chunk_cols,
        "chunk_count": chunk_rows * chunk_cols,
    }


def export_distribution_chunks(distribution: np.ndarray, output_dir: Path, chunk_size: int) -> dict[str, int]:
    output_dir.mkdir(parents=True, exist_ok=True)
    bands, height, width = distribution.shape
    summary = chunk_summary(width, height, chunk_size)

    for chunk_row in range(summary["chunk_rows"]):
        row_off = chunk_row * chunk_size
        chunk_height = min(chunk_size, height - row_off)
        for chunk_col in range(summary["chunk_cols"]):
            col_off = chunk_col * chunk_size
            chunk_width = min(chunk_size, width - col_off)
            block = distribution[:, row_off : row_off + chunk_height, col_off : col_off + chunk_width]
            pixel_interleaved = np.moveaxis(block, 0, -1).astype(np.uint8, copy=False)
            path = output_dir / f"r{chunk_row}-c{chunk_col}.bin"
            path.write_bytes(pixel_interleaved.tobytes(order="C"))

    return summary


def export_risk_chunks(
    hazard: np.ndarray,
    population: np.ndarray,
    vulnerability: np.ndarray,
    heat_risk: np.ndarray,
    output_dir: Path,
    chunk_size: int,
) -> dict[str, int]:
    output_dir.mkdir(parents=True, exist_ok=True)
    height, width = heat_risk.shape
    summary = chunk_summary(width, height, chunk_size)

    for chunk_row in range(summary["chunk_rows"]):
        row_off = chunk_row * chunk_size
        chunk_height = min(chunk_size, height - row_off)
        for chunk_col in range(summary["chunk_cols"]):
            col_off = chunk_col * chunk_size
            chunk_width = min(chunk_size, width - col_off)
            stacked = np.stack(
                [
                    hazard[row_off : row_off + chunk_height, col_off : col_off + chunk_width],
                    population[row_off : row_off + chunk_height, col_off : col_off + chunk_width],
                    vulnerability[row_off : row_off + chunk_height, col_off : col_off + chunk_width],
                    heat_risk[row_off : row_off + chunk_height, col_off : col_off + chunk_width],
                ],
                axis=-1,
            ).astype(np.float32, copy=False)
            path = output_dir / f"r{chunk_row}-c{chunk_col}.bin"
            path.write_bytes(stacked.tobytes(order="C"))

    return summary


def render_threshold_tiles(
    grid: np.ndarray,
    threshold: int,
    src_transform: Affine,
    src_crs,
    bounds_lonlat: tuple[float, float, float, float],
    zoom_min: int,
    zoom_max: int,
    palette: np.ndarray,
    palette_max: float,
    output_dir: Path,
    nodata: float,
) -> int:
    tile_total = 0
    for zoom in range(zoom_min, zoom_max + 1):
        tiles = list(mercantile.tiles(*bounds_lonlat, zooms=[zoom]))
        for tile in tiles:
            left, bottom, right, top = tile_bounds_mercator(tile)
            tile_transform = from_bounds(left, bottom, right, top, TILE_SIZE, TILE_SIZE)
            destination = np.full((TILE_SIZE, TILE_SIZE), nodata, dtype=np.float32)
            reproject(
                source=grid,
                destination=destination,
                src_transform=src_transform,
                src_crs=src_crs,
                src_nodata=nodata,
                dst_transform=tile_transform,
                dst_crs="EPSG:3857",
                dst_nodata=nodata,
                resampling=Resampling.average,
            )
            rgba = colorize_tile(destination, palette, nodata, palette_max)
            save_rgba_png(output_dir / str(threshold) / str(tile.z) / str(tile.x) / f"{tile.y}.png", rgba)
            tile_total += 1
    return tile_total


def threshold_stats(values: np.ndarray, valid_mask: np.ndarray) -> dict[str, float]:
    if not np.any(valid_mask):
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "p90": 0.0}
    valid_values = values[valid_mask]
    return {
        "min": float(valid_values.min()),
        "max": float(valid_values.max()),
        "mean": float(valid_values.mean()),
        "p90": float(np.percentile(valid_values, 90)),
    }


def legend_stops(domain_max: float) -> list[dict[str, float | str]]:
    return [
        {"value": round(position * domain_max, 3), "color": f"rgba({r}, {g}, {b}, 1)"}
        for position, (r, g, b) in COLOR_STOPS
    ]


def raster_grid_metadata(dataset: rasterio.io.DatasetReader, nodata_override: float | None = None) -> dict[str, object]:
    nodata = dataset.nodata if nodata_override is None else nodata_override
    return {
        "width": dataset.width,
        "height": dataset.height,
        "transform": affine_to_list(dataset.transform),
        "bounds": [dataset.bounds.left, dataset.bounds.bottom, dataset.bounds.right, dataset.bounds.top],
        "crs": str(dataset.crs),
        "nodata": float(nodata),
    }


def remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def build_outputs(
    hazard_path: Path,
    population_path: Path,
    vulnerability_path: Path,
    output_root: Path,
    zoom_min: int,
    zoom_max: int,
    chunk_size: int,
    clean: bool,
) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    metadata_path = output_root / "metadata.json"
    hazard_tiles_dir = output_root / "hazard" / "tiles"
    hazard_pixels_dir = output_root / "hazard" / "pixels"
    risk_tiles_dir = output_root / "risk" / "tiles"
    risk_pixels_root = output_root / "risk" / "pixels"

    if clean:
        for path in (
            output_root / "hazard",
            output_root / "risk",
            output_root / "tiles",
            output_root / "pixels",
            metadata_path,
        ):
            remove_path(path)

    hazard_palette = build_palette(365)

    with (
        rasterio.open(hazard_path) as hazard_src,
        rasterio.open(population_path) as population_src,
        rasterio.open(vulnerability_path) as vulnerability_src,
    ):
        if (
            population_src.width != vulnerability_src.width
            or population_src.height != vulnerability_src.height
            or population_src.transform != vulnerability_src.transform
            or str(population_src.crs) != str(vulnerability_src.crs)
        ):
            raise RuntimeError("Population and vulnerability rasters must be aligned on the same grid.")

        hazard_distribution = hazard_src.read()
        hazard_nodata = int(hazard_src.nodata if hazard_src.nodata is not None else NODATA_U8)
        hazard_valid_mask = np.any(hazard_distribution != hazard_nodata, axis=0)
        if not np.any(hazard_valid_mask):
            raise RuntimeError("No valid pixels found in the hazard distribution raster.")

        hazard_counts = np.where(hazard_distribution == hazard_nodata, 0, hazard_distribution).astype(np.uint8)
        hazard_cube = compute_hazard_cube(hazard_counts)
        yearly_days = np.unique(hazard_cube[0][hazard_valid_mask])
        if yearly_days.size != 1:
            raise RuntimeError(f"Expected one yearly day total, got {yearly_days.tolist()[:8]}")

        hazard_chunk_info = export_distribution_chunks(hazard_distribution, hazard_pixels_dir, chunk_size)
        hazard_bounds = (
            hazard_src.bounds.left,
            hazard_src.bounds.bottom,
            hazard_src.bounds.right,
            hazard_src.bounds.top,
        )

        hazard_stats_by_threshold: dict[str, dict[str, float]] = {}
        hazard_tiles_written = 0
        thresholds = list(range(0, 51))

        for threshold in thresholds:
            hazard_values = np.where(hazard_valid_mask, hazard_cube[threshold].astype(np.float32), HAZARD_NODATA)
            hazard_stats_by_threshold[str(threshold)] = threshold_stats(hazard_cube[threshold], hazard_valid_mask)
            hazard_tiles_written += render_threshold_tiles(
                hazard_values,
                threshold,
                hazard_src.transform,
                hazard_src.crs,
                hazard_bounds,
                zoom_min,
                zoom_max,
                hazard_palette,
                365,
                hazard_tiles_dir,
                HAZARD_NODATA,
            )

        population = population_src.read(1).astype(np.float32)
        vulnerability = vulnerability_src.read(5).astype(np.float32)
        population_valid = population != float(population_src.nodata)
        vulnerability_valid = vulnerability != float(vulnerability_src.nodata)

        risk_arrays: dict[int, np.ndarray] = {}
        risk_stats_by_threshold: dict[str, dict[str, float]] = {}
        risk_chunk_info: dict[str, int] | None = None
        risk_global_max = 0.0
        risk_bounds = (
            population_src.bounds.left,
            population_src.bounds.bottom,
            population_src.bounds.right,
            population_src.bounds.top,
        )

        for threshold in thresholds:
            hazard_on_risk_grid = np.full((population_src.height, population_src.width), HAZARD_NODATA, dtype=np.float32)
            hazard_values = np.where(hazard_valid_mask, hazard_cube[threshold].astype(np.float32), HAZARD_NODATA)
            reproject(
                source=hazard_values,
                destination=hazard_on_risk_grid,
                src_transform=hazard_src.transform,
                src_crs=hazard_src.crs,
                src_nodata=HAZARD_NODATA,
                dst_transform=population_src.transform,
                dst_crs=population_src.crs,
                dst_nodata=HAZARD_NODATA,
                resampling=Resampling.average,
            )

            heat_risk = np.full_like(hazard_on_risk_grid, RISK_NODATA, dtype=np.float32)
            risk_valid_mask = (hazard_on_risk_grid != HAZARD_NODATA) & population_valid & vulnerability_valid
            heat_risk[risk_valid_mask] = (
                hazard_on_risk_grid[risk_valid_mask]
                * population[risk_valid_mask]
                * (1.0 + vulnerability[risk_valid_mask])
            )
            risk_stats = threshold_stats(heat_risk, risk_valid_mask)
            risk_stats_by_threshold[str(threshold)] = risk_stats
            risk_global_max = max(risk_global_max, risk_stats["max"])
            risk_arrays[threshold] = heat_risk

            risk_chunk_info = export_risk_chunks(
                hazard_on_risk_grid,
                population,
                vulnerability,
                heat_risk,
                risk_pixels_root / str(threshold),
                chunk_size,
            )

        risk_palette_max = max(1, int(math.ceil(risk_global_max)))
        risk_palette = build_palette(risk_palette_max)
        risk_tiles_written = 0

        for threshold in thresholds:
            risk_tiles_written += render_threshold_tiles(
                risk_arrays[threshold],
                threshold,
                population_src.transform,
                population_src.crs,
                risk_bounds,
                zoom_min,
                zoom_max,
                risk_palette,
                risk_palette_max,
                risk_tiles_dir,
                RISK_NODATA,
            )

        if risk_chunk_info is None:
            raise RuntimeError("Failed to build risk pixel chunk metadata.")

        metadata = {
            "cityKey": "nairobi",
            "cityLabel": "Nairobi",
            "availableModes": ["hazard", "heatRisk"],
            "defaultMode": "hazard",
            "defaultThreshold": 25,
            "thresholds": thresholds,
            "bounds": list(hazard_bounds),
            "rawDataPaths": {
                "hazard": str(hazard_path).replace("\\", "/"),
                "populationNational": "data/raw/population/ken_pop_2025_CN_100m_R2025A_v1.tif",
                "populationNairobi": str(population_path).replace("\\", "/"),
                "vulnerability": str(vulnerability_path).replace("\\", "/"),
            },
            "modes": {
                "hazard": {
                    "label": "Hazard",
                    "units": {"temperature": "°C", "hazard": "days"},
                    "tileSize": TILE_SIZE,
                    "zoomRange": {"min": zoom_min, "max": zoom_max},
                    "bounds": list(hazard_bounds),
                    "legendDomain": [0, 365],
                    "legendStops": legend_stops(365),
                    "tilesPathTemplate": "hazard/tiles/{threshold}/{z}/{x}/{y}.png",
                    "rasterGrid": raster_grid_metadata(hazard_src, HAZARD_NODATA),
                    "statsByThreshold": hazard_stats_by_threshold,
                    "generated": {
                        "thresholdCount": len(thresholds),
                        "tilesWritten": hazard_tiles_written,
                    },
                    "thresholdModeLabel": "Days above threshold",
                    "definition": "hazard_days(threshold) = sum of yearly bin counts where bin lower edge >= threshold",
                    "pixelQuery": {
                        "kind": "distribution",
                        "pathTemplate": "hazard/pixels/r{row}-c{col}.bin",
                        "chunkSize": chunk_size,
                        "bands": hazard_src.count,
                        "interleave": "pixel",
                        **hazard_chunk_info,
                    },
                    "binEdges": list(range(0, 51)),
                    "binLabels": [f"{start}-{start + 1}°C" for start in range(0, 50)],
                },
                "heatRisk": {
                    "label": "Heat Risk",
                    "units": {
                        "hazard": "days",
                        "population": "people",
                        "vulnerability": "ratio",
                        "heatRisk": "risk",
                    },
                    "tileSize": TILE_SIZE,
                    "zoomRange": {"min": zoom_min, "max": zoom_max},
                    "bounds": list(risk_bounds),
                    "legendDomain": [0, float(risk_palette_max)],
                    "legendStops": legend_stops(float(risk_palette_max)),
                    "tilesPathTemplate": "risk/tiles/{threshold}/{z}/{x}/{y}.png",
                    "rasterGrid": raster_grid_metadata(population_src, RISK_NODATA),
                    "statsByThreshold": risk_stats_by_threshold,
                    "generated": {
                        "thresholdCount": len(thresholds),
                        "tilesWritten": risk_tiles_written,
                    },
                    "formula": "heat_risk = hazard x population x (1 + vulnerability)",
                    "pixelQuery": {
                        "kind": "riskDetail",
                        "pathTemplate": "risk/pixels/{threshold}/r{row}-c{col}.bin",
                        "chunkSize": chunk_size,
                        "fields": RISK_FIELD_NAMES,
                        "dtype": "float32",
                        "interleave": "pixel",
                        **risk_chunk_info,
                    },
                },
            },
        }
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    return metadata_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static hazard and heat-risk tiles for the Nairobi viewer.")
    parser.add_argument("--hazard", default=Path("data/raw/hazard/temp_dist_nairobi.tif"), type=Path)
    parser.add_argument("--population", default=Path("data/raw/population/ken_pop_nairobi_100m.tif"), type=Path)
    parser.add_argument("--vulnerability", default=Path("data/raw/vulnerability/population_composite_nairobi.tif"), type=Path)
    parser.add_argument("--output", default=Path("frontend/public/data"), type=Path)
    parser.add_argument("--zoom-min", default=ZOOM_MIN, type=int)
    parser.add_argument("--zoom-max", default=ZOOM_MAX, type=int)
    parser.add_argument("--chunk-size", default=CHUNK_SIZE, type=int)
    parser.add_argument("--clean", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    metadata_path = build_outputs(
        hazard_path=args.hazard,
        population_path=args.population,
        vulnerability_path=args.vulnerability,
        output_root=args.output,
        zoom_min=args.zoom_min,
        zoom_max=args.zoom_max,
        chunk_size=args.chunk_size,
        clean=args.clean,
    )
    print(f"Generated metadata: {metadata_path}")


if __name__ == "__main__":
    main()
