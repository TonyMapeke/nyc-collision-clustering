const API_URL = "http://127.0.0.1:8000";

const BRONX_BOUNDS = L.latLngBounds([40.78, -73.95], [40.92, -73.74]);

const map = L.map("map", {
  maxBounds: BRONX_BOUNDS.pad(0.5), // some room around the edges so it doesn't feel too tight
  maxBoundsViscosity: 1.0,          // hard wallm can't drag past
}).fitBounds(BRONX_BOUNDS);

map.setMinZoom(map.getZoom() - 1);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// browser API check
fetch(`${API_URL}/health`)
  .then((res) => res.json())
  .then((data) => console.log("API:", data))
  .catch((err) => console.error("Can't reach API:", err));