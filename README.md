# Bronx Collision Hotspot Analysis

Finds the most dangerous places to be on a Bronx road by clustering 225K+ motor vehicle collisions into hotspots and ranking them by harm, not just crash count. Results are served through a FastAPI + PostGIS backend to an interactive Leaflet map where you can search streets, click anywhere for the nearest hotspot, and zoom from a borough-wide heatmap down to individual intersections.

## Why severity, not frequency

Ranking locations by raw crash count mostly tells you where traffic is heaviest. West Fordham Road has the most crashes of any hotspot in the Bronx (1,027), but none of them were fatal.

Weighting by injuries and fatalities changes the picture. East 138 Street has only 208 crashes but four deaths, the most of any hotspot, and it ranks first. Several lower-volume locations on Southern Boulevard, the Grand Concourse, and White Plains Road also move into the top 10 for the same reason. A frequency-only ranking would have buried all of them.

Each factor is min-max scaled to 0–1 before weighting. Without that step, crash counts (which run into the thousands) drowned out fatalities (which top out at four), and the first version of the score just reproduced the crash-count ranking.

## Pipeline

| Stage | Notebook | What happens |
|---|---|---|
| Collection | `01_data_collection.ipynb` | Pulls every Bronx collision from NYC Open Data's Socrata API (234,088 rows). An early pull with a fixed row limit silently stopped at 200,000 rows, so it now pages through in batches of 50,000, ordered by `collision_id` so pages never overlap or skip rows. |
| Cleaning / EDA | `02_exploratory_data_analysis.ipynb` | Drops missing and `0,0` placeholder coordinates, then spatially joins against NYC's official borough boundary to remove points geocoded outside the Bronx (225,012 rows remain). Looks at temporal patterns, injury/fatality rates, and contributing factors. |
| Clustering | `03_bronx_clustering.ipynb` | Reprojects to UTM Zone 18N (meters) and runs DBSCAN. Final parameters are `eps=20m`, `min_samples=10`, giving 4,465 hotspots. Larger `eps` values chained whole corridors together; smaller ones added noise without improving the clusters. At this scale a hotspot is a stretch of road with repeated crashes, not a single intersection. |
| Severity scoring | `04_severity_weighting.ipynb` | Scores each hotspot on crash count, injuries, and fatalities (MinMax-normalized, fatalities weighted 2x). Also finds each hotspot's most common contributing factor and cross street, so hotspots are labeled like "East Gun Hill Road & Webster Avenue." |
| Density heatmap | `05_density_heatmap.ipynb` | Builds a severity-weighted kernel density surface over the whole borough and exports it as a 100×100 grid, so the heatmap agrees with the hotspot ranking. |
| Database | `sql/schema.sql`, `scripts/load_to_postgres.py` | Loads hotspots and the heatmap grid into PostgreSQL with PostGIS point geometry and GiST spatial indexes, and ranks hotspots with a SQL window function. |
| API | `api/` | FastAPI endpoints for the heatmap, all hotspots, street search, nearest-hotspot lookup, and hotspot detail. |
| Frontend | `frontend/` | Leaflet map of the Bronx: the heatmap when zoomed out, a circle per hotspot (colored by rank) when zoomed in, click-for-details popups, and street search. |

## Stack

Python, pandas, GeoPandas, Shapely, scikit-learn, SciPy, seaborn, PostgreSQL + PostGIS, SQLAlchemy, FastAPI, JavaScript, Leaflet

## Project structure

```
nyc-collision-clustering/
├── api/
│   ├── main.py          # endpoints
│   ├── database.py      # SQLAlchemy engine
│   └── schemas.py       # Pydantic response models
├── data/
│   ├── raw/             # untouched API pull (gitignored)
│   └── processed/       # cleaned and derived outputs (gitignored)
├── frontend/
│   ├── index.html
│   ├── app.js           # map, heatmap, circles, popups, search
│   └── style.css
├── notebooks/           # 01–05, run in order
├── scripts/
│   └── load_to_postgres.py
├── sql/
│   └── schema.sql
└── requirements.txt
```

## Running it locally

CSVs are gitignored, so the data has to be regenerated before anything else works.

**1. Install dependencies**

```
python -m pip install -r requirements.txt
```

**2. Generate the data**

Run notebooks `01` through `05` in order. Each one saves its output to `data/` for the next one to load.

**3. Set up the database**

Install PostgreSQL with the PostGIS extension, then create the database:

```sql
CREATE DATABASE bronx_collisions;
```

Create a `.env` file in the project root:

```
BRONX_DB_PASSWORD=your_postgres_password
```

Then, connected to `bronx_collisions`:

1. Run the structure section of `sql/schema.sql` (tables and indexes)
2. Load the data: `python scripts/load_to_postgres.py`

The load script empties the tables, loads both CSVs, and fills in the geometry columns and danger ranks in a single transaction, so it's also how you reload after rerunning the notebooks.

**4. Start the API**

```
python -m uvicorn api.main:app --reload
```

Interactive docs are at http://127.0.0.1:8000/docs.

**5. Start the frontend**

In a second terminal:

```
python -m http.server 5500 --directory frontend
```

Then open http://localhost:5500. The page has to be served rather than opened as a file, since the browser blocks API calls from local files.

Optional: for the muted CARTO basemap, create `frontend/config.js` (gitignored) with a [free CARTO key](https://carto.com/basemaps/apikey):

```js
const CARTO_KEY = "your_key";
```

Without it, the map falls back to standard OpenStreetMap tiles.

## API

| Endpoint | Description |
|---|---|
| `GET /heatmap` | Full severity-weighted density grid (10,000 points) |
| `GET /hotspots` | Every hotspot, most dangerous first |
| `GET /hotspots/search?query=` | Hotspots on or crossing a matching street, most dangerous first |
| `GET /hotspots/nearby?lat=&lon=&radius=` | Hotspots within a radius (meters) of a point, nearest first |
| `GET /hotspots/{cluster_id}` | Full detail for one hotspot |
| `GET /health` | Checks the API can reach the database |

## Data notes

- Only 2 of 4,465 hotspots are unnamed. Originally 715 had no name, since every crash in them was missing `on_street_name`. Most of those crashes still had a cross street, so pooling both street columns recovered nearly all of them.
- "Unspecified" is the single most common contributing factor (~41% of crashes), so `top_factor` often reads "Unspecified".
- Some fatal crashes list zero injuries. That's how this dataset reports the two fields (a person killed isn't always also counted as injured), not a cleaning error.
- 2026 data only runs through mid-year, and recent years may still be affected by reporting lag.
- The danger score measures total harm at a location, not harm per crash, so busy corridors still get credit for volume. A per-crash rate would favor quieter roads with unusually severe crashes instead. Total harm was the deliberate choice here.

## Status

v1 is complete: the data pipeline, database, API, and map all work end to end locally.

Next up:

- Design pass: styling, a color legend, and clipping the heatmap to the Bronx outline
- API tests with pytest
- Docker setup and deployment
- Filtering by year, severity, or cause

## Data source

[Motor Vehicle Collisions – Crashes](https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95), NYC Open Data