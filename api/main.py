"""
Bronx collision hotspot API.

    python -m uvicorn api.main:app --reload
"""

from fastapi import FastAPI, HTTPException, Query
from sqlalchemy import text

from api.database import engine
from api.schemas import HeatmapPoint, Hotspot, NearbyHotspot

app = FastAPI(
    title="Bronx Collision Hotspot API",
    description="Severity-weighted collision hotspots and density heatmap for the Bronx.",
    version="0.1.0",
)

# TRIM because the NYC data pads street names with trailing spaces
HOTSPOT_COLUMNS = """
    cluster, crash_count, center_lat, center_lon, TRIM(top_street) AS top_street,
    total_injured, total_killed, fatal_crash_count, injury_rate,
    danger_score, top_factor
"""

# ::geography so distances come back in meters, not degrees
CLICK_POINT = "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography"


@app.get("/health")
def health_check():
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/heatmap", response_model=list[HeatmapPoint])
def get_heatmap():
    """Full density grid (10k points). Small enough to send in one go."""
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT lat, lon, intensity FROM heatmap_points")
        ).mappings().all()
    return rows


# /search and /nearby must stay above /{cluster_id} or they'd match it first
@app.get("/hotspots/search", response_model=list[Hotspot])
def search_hotspots(
    query: str = Query(..., min_length=2, description="Street name to search for"),
    limit: int = Query(20, ge=1, le=100),
):
    """Street name search. Substring match, case-insensitive."""
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                f"""
                SELECT {HOTSPOT_COLUMNS}
                FROM hotspots
                WHERE top_street ILIKE :pattern
                ORDER BY danger_score DESC
                LIMIT :limit
                """
            ),
            {"pattern": f"%{query}%", "limit": limit},
        ).mappings().all()
    return rows


@app.get("/hotspots/nearby", response_model=list[NearbyHotspot])
def get_nearby_hotspots(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius: float = Query(500, gt=0, le=5000, description="Search radius in meters"),
    limit: int = Query(5, ge=1, le=50),
):
    """Hotspots near a clicked point, nearest first."""
    # ST_DWithin filters (hits the GiST index), ST_Distance only runs on what's left
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                f"""
                SELECT {HOTSPOT_COLUMNS},
                       ST_Distance(geom::geography, {CLICK_POINT}) AS distance_meters
                FROM hotspots
                WHERE ST_DWithin(geom::geography, {CLICK_POINT}, :radius)
                ORDER BY distance_meters
                LIMIT :limit
                """
            ),
            {"lat": lat, "lon": lon, "radius": radius, "limit": limit},
        ).mappings().all()
    return rows


@app.get("/hotspots/{cluster_id}", response_model=Hotspot)
def get_hotspot(cluster_id: int):
    with engine.connect() as conn:
        row = conn.execute(
            text(f"SELECT {HOTSPOT_COLUMNS} FROM hotspots WHERE cluster = :cluster_id"),
            {"cluster_id": cluster_id},
        ).mappings().first()

    if row is None:
        raise HTTPException(status_code=404, detail=f"No hotspot with cluster {cluster_id}")
    return row
