"""
Load the finalized, processed CSV outputs into the bronx_collisions Postgres database.

Loads:
  - bronx_cluster_summary_scored.csv -> hotspots table
    (drops crash_count_norm / injured_norm / killed_norm -- these were
    intermediate MinMax-scaled values used only to compute danger_score,
    and were deliberately excluded from the database schema)
  - bronx_density_heatmap.csv -> heatmap_points table
    (already an exact 1:1 match: lat, lon, intensity)

Does NOT populate the `geom` (PostGIS point) columns on either table.
That's a separate step, run after this script, using raw SQL
(ST_SetSRID(ST_MakePoint(lon, lat), 4326)) rather than a pandas write.

Requires: pandas, sqlalchemy, psycopg2-binary, python-dotenv
    pip install sqlalchemy psycopg2-binary python-dotenv

Expects a .env file (NOT committed to git -- add ".env" to .gitignore)
in the same folder as this script, containing at minimum:
    BRONX_DB_PASSWORD=your_actual_postgres_password
"""

import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine

# --- Load DB credentials from environment variables (via .env file) ---
# Keeping the password out of the source file itself matters here because
# this script is meant to be committed to a public portfolio repo -- a
# hardcoded password in git history is a real, well-known mistake.
load_dotenv()

DB_USER = os.environ.get("BRONX_DB_USER", "postgres")
DB_PASSWORD = os.environ["BRONX_DB_PASSWORD"]  # no default -- fail loudly if missing, rather than silently connecting wrong
DB_HOST = os.environ.get("BRONX_DB_HOST", "localhost")
DB_PORT = os.environ.get("BRONX_DB_PORT", "5432")
DB_NAME = os.environ.get("BRONX_DB_NAME", "bronx_collisions")

engine = create_engine(
    f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

# --- Resolve data paths relative to THIS SCRIPT'S location, not the current
# working directory. Relative paths like "../data/processed/..." only work
# if you happen to run the script from the exact folder it expects -- this
# makes it work the same way no matter where you run it from. ---
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent / "data" / "processed"


def load_hotspots():
    cluster_summary = pd.read_csv(DATA_DIR / "bronx_cluster_summary_scored.csv")

    # Keep only the columns that exist in the `hotspots` table, in that order.
    hotspots_cols = [
        "cluster", "crash_count", "center_lat", "center_lon", "top_street",
        "total_injured", "total_killed", "fatal_crash_count", "injury_rate",
        "danger_score", "top_factor",
    ]
    hotspots_df = cluster_summary[hotspots_cols]

    hotspots_df.to_sql(
        "hotspots",
        engine,
        if_exists="append",  # table already exists (created via CREATE TABLE) -- insert rows, don't recreate the table
        index=False,
    )
    print(f"Loaded {len(hotspots_df)} rows into hotspots")


def load_heatmap_points():
    heatmap_df = pd.read_csv(DATA_DIR / "bronx_density_heatmap.csv")
    # Already exactly lat, lon, intensity -- no column selection needed.

    heatmap_df.to_sql(
        "heatmap_points",
        engine,
        if_exists="append",
        index=False,
    )
    print(f"Loaded {len(heatmap_df)} rows into heatmap_points")


if __name__ == "__main__":
    load_hotspots()
    load_heatmap_points()