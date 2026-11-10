"""
Reload the bronx_collisions database from the processed CSVs.

    python scripts/load_to_postgres.py

One command does the whole reload, in a single transaction:
  1. empties the hotspots and heatmap_points tables
  2. loads bronx_cluster_summary_scored.csv and bronx_density_heatmap.csv
  3. fills in the PostGIS geom columns and danger ranks
If any step fails, nothing is changed.

The tables themselves come from the structure section of sql/schema.sql.
Credentials come from .env in the project root (gitignored).
"""

import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data" / "processed"
load_dotenv(PROJECT_ROOT / ".env")  # same .env the api uses, wherever this is run from

DB_USER = os.environ.get("BRONX_DB_USER", "postgres")
DB_PASSWORD = os.environ["BRONX_DB_PASSWORD"]  # no default, fail loudly if missing
DB_HOST = os.environ.get("BRONX_DB_HOST", "localhost")
DB_PORT = os.environ.get("BRONX_DB_PORT", "5432")
DB_NAME = os.environ.get("BRONX_DB_NAME", "bronx_collisions")

engine = create_engine(
    f"postgresql+psycopg2://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

# columns that exist in the hotspots table; the _norm columns were only used to compute danger_score
HOTSPOT_COLUMNS = [
    "cluster", "crash_count", "center_lat", "center_lon", "top_street",
    "total_injured", "total_killed", "fatal_crash_count", "injury_rate",
    "danger_score", "top_factor", "cross_street",
]

# same statements as the backfill section of sql/schema.sql
BACKFILL = [
    """
    UPDATE hotspots
    SET geom = ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)
    """,
    """
    UPDATE heatmap_points
    SET geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326)
    """,
    """
    UPDATE hotspots h
    SET danger_rank = r.danger_rank
    FROM (
        SELECT cluster, RANK() OVER (ORDER BY danger_score DESC) AS danger_rank
        FROM hotspots
    ) r
    WHERE h.cluster = r.cluster
    """,
]


def reload():
    hotspots = pd.read_csv(DATA_DIR / "bronx_cluster_summary_scored.csv")[HOTSPOT_COLUMNS]
    heatmap = pd.read_csv(DATA_DIR / "bronx_density_heatmap.csv")

    # engine.begin() commits only if everything inside succeeds, otherwise rolls it all back
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE hotspots, heatmap_points"))

        # append, never replace: replace would drop the tables and lose the PostGIS columns and indexes
        hotspots.to_sql("hotspots", conn, if_exists="append", index=False)
        heatmap.to_sql("heatmap_points", conn, if_exists="append", index=False)

        for statement in BACKFILL:
            conn.execute(text(statement))

        counts = conn.execute(text("""
            SELECT COUNT(*), COUNT(geom), COUNT(danger_rank) FROM hotspots
        """)).one()

    print(f"hotspots: {counts[0]} rows, {counts[1]} with geom, {counts[2]} ranked")
    print(f"heatmap_points: {len(heatmap)} rows")


if __name__ == "__main__":
    reload()