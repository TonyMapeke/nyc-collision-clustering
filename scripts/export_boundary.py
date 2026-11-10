"""
Export the Bronx outline for the frontend.

Writes frontend/bronx_boundary.geojson, which the map uses to clip the heatmap
to the borough and dim everything outside it. Same NYC borough boundary data
as the spatial join in notebook 02.

    python scripts/export_boundary.py
"""

from pathlib import Path

import geopandas as gpd

BOUNDARY_URL = "https://data.cityofnewyork.us/resource/gthc-hcne.geojson"
OUT = Path(__file__).resolve().parent.parent / "frontend" / "bronx_boundary.geojson"

boroughs = gpd.read_file(BOUNDARY_URL)
bronx = boroughs[boroughs["boroname"] == "Bronx"][["boroname", "geometry"]]

# simplify in meters (UTM 18N) so the file stays small, then back to lat/lon for leaflet
bronx = bronx.to_crs(epsg=32618)
bronx["geometry"] = bronx.simplify(10)  # 10 m tolerance, invisible at street zoom
bronx = bronx.to_crs(epsg=4326)

bronx.to_file(OUT, driver="GeoJSON", COORDINATE_PRECISION=6)
print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")