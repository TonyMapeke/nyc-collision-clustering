-- schema.sql
-- Full DDL history for the bronx_collisions database (Bronx Collision Hotspot project).
-- Running this file recreates the table structure, indexes, and geometry columns
-- from nothing -- it does NOT load any data (that's scripts/load_to_postgres.py).
--
-- Prerequisites (run once, manually, before this file):
--   1. Install PostgreSQL + PostGIS.
--   2. CREATE DATABASE bronx_collisions;   -- run while connected to any existing db (e.g. postgres)
--   3. Connect to bronx_collisions specifically before running this file --
--      e.g. in pgAdmin, open a Query Tool against bronx_collisions, or from
--      the command line: psql -U postgres -d bronx_collisions -f schema.sql
--
-- Order of operations for a full rebuild from empty:
--   (a) Run the STRUCTURE section below to create the extension, tables, and indexes.
--   (b) Run scripts/load_to_postgres.py to load bronx_cluster_summary_scored.csv
--       and bronx_density_heatmap.csv into the now-empty tables.
--   (c) Run the BACKFILL GEOM section below to populate the geom columns from
--       the freshly-loaded lat/lon values. (Running it before step (b) is harmless
--       but accomplishes nothing -- WHERE geom IS NULL matches zero rows on empty tables.)

-- ============================================================
-- STRUCTURE: extension, tables, indexes
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE hotspots (
    cluster INTEGER PRIMARY KEY,
    crash_count INTEGER,
    center_lat DOUBLE PRECISION,
    center_lon DOUBLE PRECISION,
    top_street TEXT,
    total_injured DOUBLE PRECISION,
    total_killed DOUBLE PRECISION,
    fatal_crash_count INTEGER,
    injury_rate DOUBLE PRECISION,
    danger_score DOUBLE PRECISION,
    top_factor TEXT,
    geom GEOMETRY(Point, 4326)
);

CREATE TABLE heatmap_points (
    id SERIAL PRIMARY KEY,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    intensity DOUBLE PRECISION,
    geom GEOMETRY(Point, 4326)
);

CREATE INDEX idx_hotspots_geom ON hotspots USING GIST (geom);
CREATE INDEX idx_heatmap_points_geom ON heatmap_points USING GIST (geom);

-- ============================================================
-- BACKFILL GEOM: populate geometry columns from lat/lon
-- Run AFTER loading data (scripts/load_to_postgres.py). Safe to re-run --
-- WHERE geom IS NULL means already-populated rows are left untouched.
-- ============================================================

UPDATE hotspots
SET geom = ST_SetSRID(ST_MakePoint(center_lon, center_lat), 4326)
WHERE geom IS NULL;

UPDATE heatmap_points
SET geom = ST_SetSRID(ST_MakePoint(lon, lat), 4326)
WHERE geom IS NULL;