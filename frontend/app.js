const API_URL = "http://127.0.0.1:8000";

const BRONX_BOUNDS = L.latLngBounds([40.78, -73.95], [40.92, -73.74]);

const map = L.map("map", {
  maxBounds: BRONX_BOUNDS.pad(0.5), // some room around the edges so it doesn't feel too tight
  maxBoundsViscosity: 1.0,          // hard wall, can't drag past
}).fitBounds(BRONX_BOUNDS);

map.setMinZoom(map.getZoom() - 1);

// CARTO if there's a key, OSM otherwise
if (typeof CARTO_KEY !== "undefined" && CARTO_KEY !== "your_key_here") {
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
    maxZoom: 19,
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
} else {
  console.warn("No CARTO key found in config.js, using OpenStreetMap tiles");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

// yellow to dark red
const HEAT_COLORS = [
  [0.0, [255, 255, 178]],
  [0.25, [254, 204, 92]],
  [0.5, [253, 141, 60]],
  [0.75, [240, 59, 32]],
  [1.0, [189, 0, 38]],
];

// blend between the two closest colors
function colorFor(t) {
  for (let i = 1; i < HEAT_COLORS.length; i++) {
    const [p1, c1] = HEAT_COLORS[i];
    if (t <= p1) {
      const [p0, c0] = HEAT_COLORS[i - 1];
      const f = (t - p0) / (p1 - p0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
    }
  }
  return HEAT_COLORS[HEAT_COLORS.length - 1][1];
}

// grid is already smoothed from the KDE, so just draw it
function drawHeatmap(points) {
  const lats = [...new Set(points.map((p) => p.lat))].sort((a, b) => a - b);
  const lons = [...new Set(points.map((p) => p.lon))].sort((a, b) => a - b);
  const rows = lats.length;
  const cols = lons.length;

  const latStep = (lats[rows - 1] - lats[0]) / (rows - 1);
  const lonStep = (lons[cols - 1] - lons[0]) / (cols - 1);

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(cols, rows);

  for (const p of points) {
    const col = Math.round((p.lon - lons[0]) / lonStep);
    const row = rows - 1 - Math.round((p.lat - lats[0]) / latStep); // flip, canvas starts at the top
    const [r, g, b] = colorFor(p.intensity);
    const i = (row * cols + col) * 4;
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = Math.round(255 * 0.8 * Math.sqrt(p.intensity)); // fades out at 0, no hard edge
  }
  ctx.putImageData(image, 0, 0);

  // pad by half a cell since each pixel is centered on a grid point
  const bounds = L.latLngBounds(
    [lats[0] - latStep / 2, lons[0] - lonStep / 2],
    [lats[rows - 1] + latStep / 2, lons[cols - 1] + lonStep / 2]
  );
  L.imageOverlay(canvas.toDataURL(), bounds).addTo(map);
}

fetch(`${API_URL}/heatmap`)
  .then((res) => res.json())
  .then(drawHeatmap)
  .catch((err) => console.error("Couldn't load heatmap:", err));

// data comes from our db but escape it anyway before it goes into html
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function popupHtml(h) {
  const street = h.top_street ? escapeHtml(h.top_street) : "Unnamed location"; // 715 clusters have no street
  return `
    <strong>${street}</strong><br>
    Danger score: ${h.danger_score.toFixed(2)}<br>
    Crashes: ${h.crash_count}<br>
    Injured: ${Math.round(h.total_injured)}<br>
    Killed: ${Math.round(h.total_killed)}<br>
    Crashes with injuries: ${Math.round(h.injury_rate)}%<br>
    Top factor: ${escapeHtml(h.top_factor ?? "Unknown")}<br>
    <small>${Math.round(h.distance_meters)} m from where you clicked</small>
  `;
}

map.on("click", (e) => {
  const { lat, lng } = e.latlng; // leaflet calls it lng, the api calls it lon
  fetch(`${API_URL}/hotspots/nearby?lat=${lat}&lon=${lng}&radius=500&limit=1`)
    .then((res) => res.json())
    .then((hotspots) => {
      if (hotspots.length === 0) {
        L.popup().setLatLng(e.latlng).setContent("No hotspots within 500 m").openOn(map);
        return;
      }
      const h = hotspots[0];
      L.popup()
        .setLatLng([h.center_lat, h.center_lon]) // open on the hotspot, not the click
        .setContent(popupHtml(h))
        .openOn(map);
    })
    .catch((err) => console.error("Couldn't load nearby hotspots:", err));
});