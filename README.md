# Nairobi Heat Hazard and Risk Viewer

A research prototype for exploring two linked indicators over Nairobi:

- `Hazard`: days at or above a temperature threshold
- `Heat Risk`: `hazard x population x (1 + vulnerability)`

The project uses a React frontend with pre-generated raster tiles and click-query chunks. Hazard is shown on the original Nairobi hazard grid, while Heat Risk is computed on the aligned 100m population grid.

## Screenshots

### Hazard Mode

![Hazard mode](Hazard.png)

### Heat Risk Mode

![Heat Risk mode](HeatRisk.png)

## Repository Layout

### Source code

- `frontend/` React + TypeScript + Vite app
- `scripts/` raster preprocessing scripts
- `tests/` Python tests for preprocessing logic

### Input data kept in the repo

- `data/raw/hazard/temp_dist_nairobi.tif`
- `data/raw/population/ken_pop_2025_CN_100m_R2025A_v1.tif`
- `data/raw/population/ken_pop_nairobi_100m.tif`
- `data/raw/vulnerability/population_composite_nairobi.tif`

### Generated files not committed

- `frontend/public/data/` generated tiles and metadata
- `data/derived/` derived helper rasters
- `frontend/dist/`, `frontend/node_modules/`, `.vite/`, `*.tsbuildinfo`

## Features

- Hazard / Heat Risk mode switch
- Shared temperature-threshold slider
- Smooth map updates without recreating the map
- Hazard pixel inspection with full yearly temperature distribution
- Heat Risk cell inspection with hazard, population, vulnerability, and risk breakdown
- Administrative boundaries and labels stay visible above raster content

## Requirements

- Python 3.12+
- Node.js 24+
- npm

## Setup

1. Install frontend dependencies

```powershell
npm --prefix frontend install
```

2. Generate frontend-ready raster assets

```powershell
npm run data:build
```

3. Start the development server

```powershell
npm run dev
```

## Build and Test

Run preprocessing and frontend tests:

```powershell
npm run test
```

Build the frontend:

```powershell
npm run build
```

## Notes

- The repo keeps the raw Nairobi input rasters so others can reproduce the generated web assets locally.
- Generated tiles are intentionally excluded from version control because they are large and can be rebuilt with `npm run data:build`.
