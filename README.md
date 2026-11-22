# Bronx Collision Hotspot Analysis

Finds the most dangerous places to be on a Bronx road by clustering 306K+ motor vehicle collisions into hotspots and ranking them by harm, not just crash count. Results are served through a FastAPI + PostGIS backend to an interactive Leaflet map where you can search streets, click anywhere for the nearest hotspot, and zoom from a borough-wide heatmap down to individual intersections.

## Why severity, not frequency

Ranking locations by raw crash count mostly tells you where traffic is heaviest. West Fordham Road at the Major Deegan Expressway has the second most crashes of any hotspot in the Bronx (1,310) and the most injuries (630), but no deaths. It ranks eighth.

Weighting by injuries and fatalities changes the picture. East 138 Street & Willis Avenue has only 227 crashes but four deaths, tied for the most of any hotspot, and ranks second. Allerton Avenue & Holland Avenue has just 69 crashes, also with four deaths, and ranks fifth. A frequency-only ranking would have buried both. The top spot, Bruckner Boulevard & Hunts Point Avenue, earns it on total harm: the most crashes in the borough (1,383) and the second most injuries (563).

Each factor is min-max scaled to 0–1 before weighting. Without that step, crash counts (which run into the thousands) drowned out fatalities (which top out at four), and the first version of the score just reproduced the crash-count ranking.

## Pipeline

| Stage | Notebook | What happens |
|---|---|---|
| Collection | `01_data_collection.ipynb` | Pulls every Bronx collision from NYC Open Data's Socrata API (330,480 rows, pulled November 21, 2026). That's crashes labeled Bronx plus crashes with no borough recorded whose coordinates fall in a box around the Bronx. About 72,000 Bronx crashes, many on highways like the Major Deegan and Cross Bronx, have no borough and were missing from earlier versions. An early pull with a fixed row limit silently stopped at 200,000 rows, so it now pages through in batches of 50,000, ordered by `collision_id` so pages never overlap or skip rows. |
| Cleaning / EDA | `02_exploratory_data_analysis.ipynb` | Drops missing and `0,0` placeholder coordinates, then spatially joins against NYC's official borough boundary to remove points geocoded outside the Bronx, including the parts of the box that aren't in the Bronx (306,641 rows remain). Looks at temporal patterns, injury/fatality rates, and contributing factors. |
| Clustering | `03_bronx_clustering.ipynb` | Reprojects to UTM Zone 18N (meters) and runs DBSCAN. Final parameters are `eps=20m`, `min_samples=10`, giving 5,324 hotspots. Larger `eps` values chained whole corridors together; smaller ones added noise without improving the clusters. At this scale a hotspot is a busy intersection or a short stretch of road; the widest spans about 300 meters. Rechecked after adding the highway crashes, to make sure they didn't chain into long strips. |
| Severity scoring | `04_severity_weighting.ipynb` | Scores each hotspot on crash count, injuries, and fatalities (MinMax-normalized, fatalities weighted 2x). Also finds each hotspot's most common contributing factor and cross street, so hotspots are labeled like "East Gun Hill Road & Webster Avenue." Street names are cleaned first: house numbers stripped, abbreviations like `EXPY` and `E` spelled out, and address-only records used as a fallback. |
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

- Only 1 of 5,324 hotspots has no street name. About 20% of crashes record their location only as an address in `off_street_name`, with `on_street_name` and `cross_street_name` blank, so the cleaning falls back to that field.
- The dataset's format changed between the June and November 2026 pulls: `collision_id` went from numbers to 32-character IDs, newer records abbreviate street names, and a new "Does Not Apply" cause appeared. The cleaning handles both formats.
- About 39% of crashes have no recorded cause ("Unspecified", or "Does Not Apply" in newer records, which are merged). `top_factor` is the most common cause that was actually recorded.
- `00:00` is the most common crash time, more than 4 PM, the busiest hour. Crashes with an unknown time were most likely logged as midnight, so the late-night counts are inflated. Nothing downstream uses time, so those rows stay in.
- Some fatal crashes list zero injuries. That's how this dataset reports the two fields (a person killed isn't always also counted as injured), not a cleaning error.
- The data was pulled on November 21, 2026. The most recent months may still be affected by reporting lag.
- The danger score measures total harm at a location, not harm per crash, so busy corridors still get credit for volume. A per-crash rate would favor quieter roads with unusually severe crashes instead. Total harm was the deliberate choice here.

## Status

The data pipeline, database, API, and map all work end to end locally, including the design pass (street-sign styling, a zoom-aware legend, a guided tour of the top three hotspots, and the heatmap clipped to the Bronx outline).

Next up:

- Deployment, so the map has a live link
- API tests with pytest
- Docker setup
- Filtering by year, severity, or cause

## Data source

[Motor Vehicle Collisions – Crashes](https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95), NYC Open Data