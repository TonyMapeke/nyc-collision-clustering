from typing import Optional

from pydantic import BaseModel


class HeatmapPoint(BaseModel):
    lat: float
    lon: float
    intensity: float


class Hotspot(BaseModel):
    cluster: int
    crash_count: int
    center_lat: float
    center_lon: float
    top_street: Optional[str] = None  # 715 clusters have no street name
    total_injured: float
    total_killed: float
    fatal_crash_count: int
    injury_rate: float
    danger_score: float
    top_factor: Optional[str] = None


class NearbyHotspot(Hotspot):
    distance_meters: float
