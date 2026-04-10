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

COLOR_STOPS = [
    (0.0, (245, 242, 230)),
    (0.12, (240, 206, 134)),
    (0.32, (236, 149, 75)),
    (0.58, (210, 78, 57)),
    (0.8, (137, 32, 55)),
    (1.0, (48, 12, 39)),
]


def build_palette(max_value: int = 365) -> np.ndarray:
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


def colorize_tile(tile_data: np.ndarray, palette: np.ndarray) -> np.ndarray:
    rgba = np.zeros((tile_data.shape[0], tile_data.shape[1], 4), dtype=np.uint8)
    valid = tile_data != HAZARD_NODATA
    if not np.any(valid):
        return rgba
    clipped = np.clip(np.rint(tile_data[valid]), 0, palette.shape[0] - 1).astype(np.int16)
    rgba[valid] = palette[clipped]
    return rgba


def save_rgba_png(path: Path, rgba: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(path)


def export_pixel_chunks(src: rasterio.io.DatasetReader, output_dir: Path, chunk_size: int) -> dict[str, int]:
    output_dir.mkdir(parents=True, exist_ok=True)
    chunk_rows = math.ceil(src.height / chunk_size)
    chunk_cols = math.ceil(src.width / chunk_size)
    chunk_count = 0

    for chunk_row in range(chunk_rows):
        row_off = chunk_row * chunk_size
        chunk_height = min(chunk_size, src.height - row_off)
        for chunk_col in range(chunk_cols):
            col_off = chunk_col * chunk_size
            chunk_width = min(chunk_size, src.width - col_off)
            window = Window(col_off=col_off, row_off=row_off, width=chunk_width, height=chunk_height)
            data = src.read(window=window)
            pixel_interleaved = np.moveaxis(data, 0, -1).astype(np.uint8, copy=False)
            path = output_dir / f"r{chunk_row}-c{chunk_col}.bin"
            path.write_bytes(pixel_interleaved.tobytes(order="C"))
            chunk_count += 1

    return {
        "chunk_rows": chunk_rows,
        "chunk_cols": chunk_cols,
        "chunk_count": chunk_count,
    }


def render_threshold_tiles(
    hazard: np.ndarray,
    threshold: int,
    src_transform: Affine,
    src_crs,
    bounds_lonlat: tuple[float, float, float, float],
    zoom_min: int,
    zoom_max: int,
    palette: np.ndarray,
    output_dir: Path,
) -> int:
    tile_total = 0
    for zoom in range(zoom_min, zoom_max + 1):
        tiles = list(mercantile.tiles(*bounds_lonlat, zooms=[zoom]))
        for tile in tiles:
            left, bottom, right, top = tile_bounds_mercator(tile)
            tile_transform = from_bounds(left, bottom, right, top, TILE_SIZE, TILE_SIZE)
            destination = np.full((TILE_SIZE, TILE_SIZE), HAZARD_NODATA, dtype=np.float32)
            reproject(
                source=hazard,
                destination=destination,
                src_transform=src_transform,
                src_crs=src_crs,
                src_nodata=HAZARD_NODATA,
                dst_transform=tile_transform,
                dst_crs="EPSG:3857",
                dst_nodata=HAZARD_NODATA,
                resampling=Resampling.average,
            )
            rgba = colorize_tile(destination, palette)
            save_rgba_png(output_dir / str(threshold) / str(tile.z) / str(tile.x) / f"{tile.y}.png", rgba)
            tile_total += 1
    return tile_total


def threshold_stats(hazard: np.ndarray, valid_mask: np.ndarray) -> dict[str, float]:
    valid_values = hazard[valid_mask]
    return {
        "min": float(valid_values.min()),
        "max": float(valid_values.max()),
        "mean": float(valid_values.mean()),
        "p90": float(np.percentile(valid_values, 90)),
    }


def build_outputs(
    source_path: Path,
    output_root: Path,
    zoom_min: int,
    zoom_max: int,
    chunk_size: int,
    clean: bool,
) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    tiles_dir = output_root / "tiles"
    pixels_dir = output_root / "pixels"
    metadata_path = output_root / "metadata.json"

    if clean:
        for path in (tiles_dir, pixels_dir):
            if path.exists():
                shutil.rmtree(path)
        if metadata_path.exists():
            metadata_path.unlink()

    palette = build_palette()

    with rasterio.open(source_path) as src:
        valid_mask = src.read(1) != src.nodata
        if not np.any(valid_mask):
            raise RuntimeError("No valid pixels found in source dataset")

        chunk_summary = export_pixel_chunks(src, pixels_dir, chunk_size)

        running_hazard = np.zeros((src.height, src.width), dtype=np.uint16)
        stats_by_threshold: dict[str, dict[str, float]] = {}
        tiles_written = 0
        bounds_lonlat = (src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top)

        zero_hazard = np.where(valid_mask, 0.0, HAZARD_NODATA).astype(np.float32)
        stats_by_threshold["50"] = threshold_stats(np.where(valid_mask, 0, 0).astype(np.uint16), valid_mask)
        tiles_written += render_threshold_tiles(
            zero_hazard,
            50,
            src.transform,
            src.crs,
            bounds_lonlat,
            zoom_min,
            zoom_max,
            palette,
            tiles_dir,
        )

        for threshold in range(src.count - 1, -1, -1):
            band = src.read(threshold + 1)
            valid_band = np.where(band == src.nodata, 0, band) if src.nodata is not None else band
            running_hazard = running_hazard + valid_band.astype(np.uint16)
            if threshold == 0:
                unique_year_days = np.unique(running_hazard[valid_mask])
                if unique_year_days.size != 1:
                    raise RuntimeError(f"Expected a single yearly-day total, got {unique_year_days.tolist()[:8]}")
            hazard_tile = np.where(valid_mask, running_hazard.astype(np.float32), HAZARD_NODATA)
            stats_by_threshold[str(threshold)] = threshold_stats(running_hazard, valid_mask)
            tiles_written += render_threshold_tiles(
                hazard_tile,
                threshold,
                src.transform,
                src.crs,
                bounds_lonlat,
                zoom_min,
                zoom_max,
                palette,
                tiles_dir,
            )

        metadata = {
            "cityKey": "nairobi",
            "cityLabel": "Nairobi",
            "thresholdModeLabel": "大于等于阈值温度的天数",
            "hazardDefinition": "hazard_days(threshold) = sum of yearly bin counts for bins whose lower edge is >= threshold",
            "units": {
                "temperature": "°C",
                "hazard": "days",
            },
            "sourceFile": source_path.name,
            "tileSize": TILE_SIZE,
            "zoomRange": {"min": zoom_min, "max": zoom_max},
            "bounds": list(bounds_lonlat),
            "thresholds": list(range(0, 51)),
            "legendDomain": [0, 365],
            "legendStops": [
                {"value": int(position * 365), "color": f"rgba({r}, {g}, {b}, 1)"}
                for position, (r, g, b) in COLOR_STOPS
            ],
            "binEdges": list(range(0, 51)),
            "binLabels": [f"{start}-{start + 1}°C" for start in range(0, 50)],
            "rasterShape": {"width": src.width, "height": src.height},
            "transform": affine_to_list(src.transform),
            "crs": str(src.crs),
            "nodata": int(src.nodata if src.nodata is not None else NODATA_U8),
            "pixelChunks": {
                "pathTemplate": "pixels/r{row}-c{col}.bin",
                "chunkSize": chunk_size,
                "bands": src.count,
                "interleave": "pixel",
                **chunk_summary,
            },
            "statsByThreshold": stats_by_threshold,
            "generated": {
                "thresholdCount": 51,
                "tilesWritten": tiles_written,
            },
        }
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    return metadata_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build static hazard tiles and pixel chunks for the Nairobi viewer.")
    parser.add_argument("--source", default="temp_dist_nairobi.tif", type=Path)
    parser.add_argument("--output", default=Path("frontend/public/data"), type=Path)
    parser.add_argument("--zoom-min", default=ZOOM_MIN, type=int)
    parser.add_argument("--zoom-max", default=ZOOM_MAX, type=int)
    parser.add_argument("--chunk-size", default=CHUNK_SIZE, type=int)
    parser.add_argument("--clean", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    metadata_path = build_outputs(
        source_path=args.source,
        output_root=args.output,
        zoom_min=args.zoom_min,
        zoom_max=args.zoom_max,
        chunk_size=args.chunk_size,
        clean=args.clean,
    )
    print(f"Generated metadata: {metadata_path}")


if __name__ == "__main__":
    main()
