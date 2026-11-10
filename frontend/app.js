const API_URL = "http://127.0.0.1:8000";

const BRONX_BOUNDS = L.latLngBounds([40.78, -73.95], [40.92, -73.74]);

const map = L.map("map", {
  maxBounds: BRONX_BOUNDS.pad(0.5), // some room around the edges so it doesn't feel too tight
  maxBoundsViscosity: 1.0,          // hard wall, can't drag past
  preferCanvas: true,
  zoomControl: false,               // re-added bottom right so it doesn't sit under the search bar               // 4,465 circles draw much faster on canvas than as svg
}).fitBounds(BRONX_BOUNDS);

map.setMinZoom(map.getZoom() - 1);
L.control.zoom({ position: "bottomright" }).addTo(map);

// CARTO if there's a key, OSM otherwise
let tiles;
if (typeof CARTO_KEY !== "undefined" && CARTO_KEY !== "your_key_here") {
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
    maxZoom: 19,
    updateWhenZooming: false, // only fetch tiles for the final zoom, not every step of a fly animation
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
} else {
  console.warn("No CARTO key found in config.js, using OpenStreetMap tiles");
  tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    updateWhenZooming: false, // only fetch tiles for the final zoom, not every step of a fly animation
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

// the opening animation waits (css paused) until the streets have loaded, otherwise it plays behind blank tiles
function startIntro() {
  document.getElementById("map").classList.add("map-ready");
}
tiles.once("load", startIntro);
setTimeout(startIntro, 3000); // don't wait forever if tiles are slow or blocked

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

let heatLayer = null;

// geojson can be a Polygon or MultiPolygon (the Bronx includes City Island), flatten to a list of rings
function boundaryRings(geojson) {
  const rings = [];
  for (const f of geojson.features) {
    const polygons = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const polygon of polygons) rings.push(...polygon);
  }
  return rings;
}

// dim everything outside the borough and draw its outline
function drawBoundary(geojson) {
  const rings = boundaryRings(geojson).map((ring) => ring.map(([lon, lat]) => [lat, lon])); // geojson is lon, lat
  const world = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
  // first ring is the outer edge, the rest are holes, so this covers everything except the bronx
  const renderer = L.svg(); // svg instead of canvas so css can animate these two on load
  L.polygon([world, ...rings], {
    stroke: false,
    fillColor: "#1e2a33",
    fillOpacity: 0.12,
    interactive: false,
    renderer,
    className: "borough-mask",
  }).addTo(map);
  const outline = L.polygon(rings, {
    color: "#1e2a33",
    weight: 1.5,
    opacity: 0.6,
    fill: false,
    interactive: false,
    renderer,
    className: "borough-outline",
  }).addTo(map);
  outline.getElement().setAttribute("pathLength", "1"); // lets css animate the stroke without knowing its real length
}

// leaflet stretches overlays in web mercator, so the clip shape has to be placed in mercator too
const toRad = (deg) => (deg * Math.PI) / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + toRad(lat) / 2));

// grid is already smoothed from the KDE, so just draw it
function drawHeatmap(points, boundary) {
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
  let output = canvas;
  if (boundary) {
    // upscale first so the borough edge is crisp, then keep only the pixels inside the outline
    const [south, west, north, east] = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
    output = document.createElement("canvas");
    output.width = 1200;
    output.height = Math.round((output.width * (mercY(north) - mercY(south))) / toRad(east - west));
    const big = output.getContext("2d");
    big.imageSmoothingEnabled = true;
    big.drawImage(canvas, 0, 0, output.width, output.height);
    big.globalCompositeOperation = "destination-in";
    big.beginPath();
    for (const ring of boundaryRings(boundary)) {
      ring.forEach(([lon, lat], i) => {
        const x = ((lon - west) / (east - west)) * output.width;
        const y = ((mercY(north) - mercY(lat)) / (mercY(north) - mercY(south))) * output.height;
        if (i === 0) big.moveTo(x, y);
        else big.lineTo(x, y);
      });
      big.closePath();
    }
    big.fill("evenodd");
  }

  heatLayer = L.imageOverlay(output.toDataURL(), bounds, { className: "heat-intro" }).addTo(map); // fades in after the outline draws
  updateLayers();
}

// the outline is a static file next to index.html, made by scripts/export_boundary.py
const boundaryRequest = fetch("bronx_boundary.geojson")
  .then((res) => (res.ok ? res.json() : null))
  .catch(() => null); // no outline file, so the heatmap just isn't clipped

Promise.all([fetch(`${API_URL}/heatmap`).then((res) => res.json()), boundaryRequest])
  .then(([points, boundary]) => {
    if (boundary) drawBoundary(boundary);
    else console.warn("No bronx_boundary.geojson, run scripts/export_boundary.py");
    drawHeatmap(points, boundary);
  })
  .catch((err) => console.error("Couldn't load heatmap:", err));

let TOTAL_HOTSPOTS = 4465; // replaced with the real count once /hotspots loads

// 1 -> 1st, 2 -> 2nd, 11 -> 11th, 22 -> 22nd
function ordinal(n) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n.toLocaleString() + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

// data comes from our db but escape it anyway before it goes into html
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// source data is all caps, "EAST 138 STREET" -> "East 138 Street"
function titleCase(text) {
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// how nyc street signs shorten names: "EAST 138 STREET" -> "E 138 St"
const SIGN_WORDS = {
  STREET: "St", AVENUE: "Av", ROAD: "Rd", BOULEVARD: "Blvd", PARKWAY: "Pkwy",
  EXPRESSWAY: "Expy", PLACE: "Pl", DRIVE: "Dr", LANE: "Ln", TERRACE: "Ter",
  COURT: "Ct", SQUARE: "Sq", PLAZA: "Plz", HIGHWAY: "Hwy",
};
const DIRECTIONS = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };
const NOT_DIRECTIONS = ["WEST FARMS"]; // a neighborhood name, not "west"

function signName(street) {
  const upper = street.trim().toUpperCase();
  const words = upper.split(/\s+/);
  const keepFirst = NOT_DIRECTIONS.some((name) => upper.startsWith(name));
  return words
    .map((word, i) => {
      if (i === 0 && words.length > 1 && !keepFirst && DIRECTIONS[word]) return DIRECTIONS[word];
      if (i === words.length - 1 && SIGN_WORDS[word]) return SIGN_WORDS[word]; // only the street type at the end
      return titleCase(word);
    })
    .join(" ");
}

// popup heading: one green sign per street, stacked like a corner post
function cornerSigns(h) {
  const streets = [h.top_street, h.cross_street].filter(Boolean);
  if (!streets.length) return `<h2 class="hs-name">Unnamed location</h2>`;
  const signs = streets.map((s) => `<span class="corner-sign">${escapeHtml(signName(s))}</span>`).join("");
  // screen readers get the full name, the signs are visual only
  return `<h2 class="hs-name"><span class="visually-hidden">${escapeHtml(hotspotName(h))}</span><span class="corner" aria-hidden="true">${signs}</span></h2>`;
}

// "Road & Cross Street", whichever parts exist
function hotspotName(h) {
  const names = [h.top_street, h.cross_street].filter(Boolean).map(titleCase);
  return names.length ? names.join(" & ") : "Unnamed location";
}

// same tiers as the circle colors
function rankTier(rank) {
  if (rank <= 50) return 1;
  if (rank <= 500) return 2;
  if (rank <= 1500) return 3;
  return 4;
}

// "Unspecified" now only comes through when no crash at this hotspot had a recorded cause
function causeText(factor) {
  if (!factor || factor === "Unspecified") return "Not recorded";
  if (factor === "Other") return "A mix of less common causes"; // the bucket for the 54 rarer causes
  return factor;
}

function popupHtml(h) {
  const killed = Math.round(h.total_killed);
  const distance = h.distance_meters != null ? `<span>${Math.round(h.distance_meters)} m from where you clicked</span>` : "";
  return `
    ${cornerSigns(h)}
    <p class="hs-rank"><span class="dot tier-${rankTier(h.danger_rank)}"></span>Ranked ${ordinal(h.danger_rank)} of ${TOTAL_HOTSPOTS.toLocaleString()} for danger</p>
    <dl class="hs-stats">
      <div><dt>Crashes</dt><dd>${h.crash_count.toLocaleString()}</dd></div>
      <div><dt>People killed</dt><dd class="${killed > 0 ? "deadly" : ""}">${killed}</dd></div>
      <div><dt>People injured</dt><dd>${Math.round(h.total_injured).toLocaleString()}</dd></div>
      <div><dt>Crashes with injuries</dt><dd>${Math.round(h.injury_rate)}%</dd></div>
    </dl>
    <p class="hs-cause">Most common recorded cause: ${escapeHtml(causeText(h.top_factor))}</p>
    <p class="hs-foot">Danger score ${h.danger_score.toFixed(2)} ${distance ? "<br>" + distance : ""}</p>
  `;
}

const POPUP_OPTIONS = { className: "hs-popup", maxWidth: 300 };

// a popup that remembers which hotspot it's for, so the selection ring knows where to go
function hotspotPopup(h) {
  const popup = L.popup(POPUP_OPTIONS);
  popup.hotspot = h;
  return popup;
}

map.on("click", (e) => {
  const { lat, lng } = e.latlng; // leaflet calls it lng, the api calls it lon
  fetch(`${API_URL}/hotspots/nearby?lat=${lat}&lon=${lng}&radius=500&limit=1`)
    .then((res) => res.json())
    .then((hotspots) => {
      if (hotspots.length === 0) {
        L.popup(POPUP_OPTIONS).setLatLng(e.latlng).setContent('<p class="hs-empty">No hotspots within 500 m. Try clicking closer to a main road.</p>').openOn(map);
        return;
      }
      const h = hotspots[0];
      hotspotPopup(h)
        .setLatLng([h.center_lat, h.center_lon]) // open on the hotspot, not the click
        .setContent(popupHtml(h))
        .openOn(map);
    })
    .catch((err) => console.error("Couldn't load nearby hotspots:", err));
});

// zoomed out: heatmap shows which areas are dangerous
// zoomed in: circles show the actual hotspots
const DETAIL_ZOOM = 16;
const hotspotLayer = L.layerGroup();

// color by rank tier, matching the legend and popup dots
const TIER_COLORS = { 1: "#bd0026", 2: "#f03b20", 3: "#fd8d3c", 4: "#fecc5c" };

function rankColor(rank) {
  return TIER_COLORS[rankTier(rank)];
}

let allHotspots = [];

// sqrt so huge clusters don't cover everything
function circleRadius(h) {
  return Math.min(14, Math.max(4, Math.sqrt(h.crash_count)));
}

// ring around whichever hotspot's popup is open, so you can see which circle it belongs to
let selectedRing = null;

map.on("popupopen", (e) => {
  const h = e.popup.hotspot;
  if (!h) return; // e.g. the "no hotspots nearby" popup
  const size = circleRadius(h) * 2 + 12;
  selectedRing = L.marker([h.center_lat, h.center_lon], {
    icon: L.divIcon({ className: "selected-ring", iconSize: [size, size] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
});

// leaflet closes the old popup before opening the next, so this runs first on a switch
map.on("popupclose", () => {
  if (selectedRing) selectedRing.remove();
  selectedRing = null;
});

function drawHotspots(hotspots) {
  allHotspots = hotspots;
  TOTAL_HOTSPOTS = hotspots.length;
  // api sends most dangerous first, so add in reverse to draw those on top
  for (const h of [...hotspots].reverse()) {
    const radius = circleRadius(h);
    const circle = L.circleMarker([h.center_lat, h.center_lon], {
      radius,
      color: "#ffffff",
      weight: 1,
      fillColor: rankColor(h.danger_rank),
      fillOpacity: 0.9,
      bubblingMouseEvents: false, // clicking a circle shouldn't also trigger the map's /nearby click
    })
      .bindPopup(() => popupHtml(h), POPUP_OPTIONS)
      .bindTooltip(escapeHtml(hotspotName(h)), { direction: "top", offset: [0, -radius], className: "hs-tooltip" })
      .on("mouseover", () => circle.setRadius(radius + 2)) // grow a little so it's clear what you're on
      .on("mouseout", () => circle.setRadius(radius))
      .addTo(hotspotLayer);
    circle.getPopup().hotspot = h;
  }
  updateLayers();
}

function updateLayers() {
  const zoomedIn = map.getZoom() >= DETAIL_ZOOM;
  if (heatLayer) heatLayer.setOpacity(zoomedIn ? 0.15 : 1); // keep a faint heatmap for context
  if (zoomedIn) hotspotLayer.addTo(map);
  else hotspotLayer.remove();
  renderLegend(zoomedIn);
}

// legend explains whichever layer is showing
const legend = document.getElementById("legend");

function renderLegend(zoomedIn) {
  if (zoomedIn) {
    legend.innerHTML = `
      <h2>Hotspots by danger rank</h2>
      <ul>
        <li><span class="dot tier-1"></span>Top 50</li>
        <li><span class="dot tier-2"></span>51 to 500</li>
        <li><span class="dot tier-3"></span>501 to 1,500</li>
        <li><span class="dot tier-4"></span>All others</li>
      </ul>
      <p class="note">Bigger circles had more crashes.</p>`;
  } else {
    legend.innerHTML = `
      <h2>Injuries and deaths</h2>
      <div class="ramp"></div>
      <div class="ends"><span>Fewer</span><span>More</span></div>
      <p class="note">Zoom in to see individual hotspots.</p>`;
  }
}

map.on("zoomend", updateLayers);

fetch(`${API_URL}/hotspots`)
  .then((res) => res.json())
  .then(drawHotspots)
  .catch((err) => console.error("Couldn't load hotspots:", err));

// search: type a street, pick a hotspot, map flies there
const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
let searchTimer = null;
let latestSearch = 0; // ignore responses that come back after a newer search
let currentResults = [];

function clearResults() {
  searchResults.replaceChildren();
  currentResults = [];
}

// fly to a hotspot, then open a popup once the map stops
// listen before moving: setView fires moveend right away, so listening after would miss it
function flyToHotspot(h, content) {
  const latlng = [h.center_lat, h.center_lon];
  map.once("moveend", () => hotspotPopup(h).setLatLng(latlng).setContent(content).openOn(map));
  if (REDUCE_MOTION) map.setView(latlng, 17);
  else map.flyTo(latlng, 17, { duration: 1.2 });
}

function goToHotspot(h) {
  clearResults();
  searchInput.value = hotspotName(h); // show what was picked
  searchInput.blur();
  flyToHotspot(h, popupHtml(h));
}

// textContent instead of innerHTML, so street names can't inject html
function showResults(hotspots) {
  currentResults = hotspots;
  if (hotspots.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No hotspots found";
    searchResults.replaceChildren(li);
    return;
  }
  searchResults.replaceChildren(
    ...hotspots.map((h) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = hotspotName(h);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `Ranked ${ordinal(h.danger_rank)}, ${h.crash_count.toLocaleString()} crashes`;
      button.append(meta);
      button.addEventListener("click", () => goToHotspot(h));
      const li = document.createElement("li");
      li.append(button);
      return li;
    })
  );
}

function runSearch(query) {
  const id = ++latestSearch;
  fetch(`${API_URL}/hotspots/search?query=${encodeURIComponent(query)}&limit=10`)
    .then((res) => res.json())
    .then((hotspots) => {
      if (id === latestSearch) showResults(hotspots);
    })
    .catch((err) => console.error("Search failed:", err));
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 2) {
    latestSearch++; // cancels any search still in flight
    clearResults();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 250); // wait for a pause in typing
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && currentResults.length) goToHotspot(currentResults[0]);
  if (e.key === "Escape") {
    searchInput.value = "";
    clearResults();
  }
});

map.on("click", clearResults);

// tour: fly through the top 3 hotspots, each with a sentence on why it ranks there
const TOUR_LENGTH = 3;

// written from the data, so it stays true if the pipeline is rerun
function tourNote(h) {
  const maxKilled = Math.max(...allHotspots.map((x) => x.total_killed));
  const maxCrashes = Math.max(...allHotspots.map((x) => x.crash_count));
  const killed = Math.round(h.total_killed);
  const crashes = h.crash_count.toLocaleString();
  const deaths = `${killed} ${killed === 1 ? "person" : "people"} killed`;
  if (h.total_killed === maxKilled && killed > 0) {
    return `The most deaths of any hotspot in the Bronx: ${deaths} in ${crashes} crashes.`;
  }
  if (h.crash_count === maxCrashes) {
    return killed === 0
      ? `The most crashes of any Bronx hotspot, but no one has died here, so it ranks below corners with fewer crashes.`
      : `The most crashes of any Bronx hotspot, with ${deaths}.`;
  }
  return `${deaths} and ${Math.round(h.total_injured).toLocaleString()} injured in ${crashes} crashes.`;
}

// popup content as an element, so the buttons can get click handlers
function tourContent(step) {
  const h = allHotspots[step];
  const last = step === TOUR_LENGTH - 1;
  const el = document.createElement("div");
  el.innerHTML = `
    ${popupHtml(h)}
    <div class="tour">
      <p class="tour-note">${escapeHtml(tourNote(h))}</p>
      <div class="tour-nav">
        <span class="tour-step">Stop ${step + 1} of ${TOUR_LENGTH}</span>
        <span class="tour-buttons">
          ${step > 0 ? '<button type="button" data-go="back">Back</button>' : ""}
          <button type="button" class="primary" data-go="next">${last ? "Explore the map" : "Next"}</button>
        </span>
      </div>
    </div>`;
  el.querySelector('[data-go="next"]').addEventListener("click", () => (last ? endTour() : tourStep(step + 1)));
  el.querySelector('[data-go="back"]')?.addEventListener("click", () => tourStep(step - 1));
  return el;
}

function tourStep(step) {
  map.closePopup();
  flyToHotspot(allHotspots[step], tourContent(step));
}

function endTour() {
  map.closePopup();
  map.fitBounds(BRONX_BOUNDS, { animate: !REDUCE_MOTION });
}

document.getElementById("tour-start").addEventListener("click", () => {
  if (allHotspots.length >= TOUR_LENGTH) tourStep(0);
});

renderLegend(false);