const COLORS = { koru: "#ff7c5c", abeona: "#62d7c8" };

function ageLabel(minutes) {
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h ago`;
  return `${(minutes / 1440).toFixed(1)}d ago`;
}

function coordinate(value, positive, negative) {
  const direction = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(4)}°${direction}`;
}

function renderVessels(payload) {
  const container = document.querySelector("#vessel-cards");
  container.innerHTML = payload.vessels.map((vessel) => {
    const latest = vessel.latest;
    const coordinates = latest
      ? `${coordinate(latest.lat, "N", "S")} · ${coordinate(latest.lon, "E", "W")}`
      : "No verified public fix";
    return `<article class="vessel-card">
      <div class="vessel-top">
        <div><p class="vessel-role">${vessel.role.replaceAll("_", " ")}</p><h3 class="vessel-name">${vessel.name}</h3></div>
        <span class="status-pill ${vessel.status}">${vessel.status.replaceAll("_", " ")}</span>
      </div>
      <p class="coordinates">${coordinates}</p>
      <dl class="vessel-meta">
        <div><dt>Fix age</dt><dd>${ageLabel(vessel.age_minutes)}</dd></div>
        <div><dt>Speed</dt><dd>${latest?.sog == null ? "—" : `${latest.sog} kn`}</dd></div>
        <div><dt>Source</dt><dd>${latest?.source ?? "—"}</dd></div>
      </dl>
    </article>`;
  }).join("");

  const pairing = document.querySelector("#pairing");
  if (payload.pairing) {
    pairing.hidden = false;
    pairing.textContent = `KORU ↔ ABEONA · ${payload.pairing.distance_nm} nautical miles apart · observations ${payload.pairing.observations_within_hours}h apart`;
  }
}

function renderEvents(payload) {
  const container = document.querySelector("#events");
  if (!payload.events.length) {
    container.innerHTML = `<article class="event"><span class="event-type">No public events yet</span><h3>The timeline begins with the next verified transition.</h3></article>`;
    return;
  }
  container.innerHTML = payload.events.map((event) => {
    const date = new Date(event.occurred_at);
    const title = event.details.port
      ? `${event.vessel_name} · ${event.details.port}`
      : `${event.vessel_name} · ${event.type.replaceAll("_", " ").toLowerCase()}`;
    return `<article class="event">
      <time datetime="${event.occurred_at}">${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</time>
      <h3>${title}</h3>
      <span class="event-type">${event.type.replaceAll("_", " ")}</span>
    </article>`;
  }).join("");
}

function renderMap(track, latest) {
  const map = L.map("map", { scrollWheelZoom: false }).setView([15, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  const bounds = [];
  track.features.forEach((feature) => {
    const id = feature.properties.vessel_id;
    const coordinates = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (coordinates.length) {
      L.polyline(coordinates, { color: COLORS[id] || "#ffffff", weight: 4, opacity: .9 }).addTo(map);
      bounds.push(...coordinates);
    }
  });
  latest.vessels.forEach((vessel) => {
    if (!vessel.latest) return;
    const point = [vessel.latest.lat, vessel.latest.lon];
    L.circleMarker(point, {
      radius: 8,
      color: "#071c22",
      weight: 3,
      fillColor: COLORS[vessel.id] || "#ffffff",
      fillOpacity: 1
    }).bindPopup(`<strong>${vessel.name}</strong><br>${vessel.status.replaceAll("_", " ")}`).addTo(map);
    bounds.push(point);
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
}

async function boot() {
  try {
    const [latestResponse, trackResponse, eventsResponse] = await Promise.all([
      fetch("data/latest.json", { cache: "no-store" }),
      fetch("data/track.geojson", { cache: "no-store" }),
      fetch("data/events.json", { cache: "no-store" })
    ]);
    if (![latestResponse, trackResponse, eventsResponse].every((response) => response.ok)) {
      throw new Error("Public data bundle unavailable");
    }
    const [latest, track, events] = await Promise.all([
      latestResponse.json(), trackResponse.json(), eventsResponse.json()
    ]);
    const healthy = latest.source_health.aisstream === "healthy";
    document.querySelector("#source-dot").classList.toggle("healthy", healthy);
    document.querySelector("#source-health").textContent = `AISSTREAM ${latest.source_health.aisstream}`;
    document.querySelector("#data-through").textContent = `PUBLIC DATA THROUGH ${new Date(latest.public_data_through).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
    renderVessels(latest);
    renderEvents(events);
    renderMap(track, latest);
  } catch (error) {
    document.querySelector("#source-health").textContent = "PUBLIC DATA UNAVAILABLE";
    document.querySelector("#vessel-cards").innerHTML = `<article class="vessel-card"><h3 class="vessel-name">Temporarily unavailable</h3><p>The last published snapshot could not be loaded.</p></article>`;
  }
}

boot();

