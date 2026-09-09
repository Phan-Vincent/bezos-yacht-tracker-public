const COLORS = { koru: "#ff7c5c", abeona: "#62d7c8" };
const REFRESH_MS = 5 * 60 * 1000;
const STATUS_LABELS = {
  current: "Current",
  stale: "Stale fix",
  signal_gap: "Signal gap",
  source_unavailable: "Source unavailable",
  no_verified_fix: "No verified fix"
};

let mapInstance = null;

function ageLabel(minutes) {
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h ago`;
  return `${(minutes / 1440).toFixed(1)}d ago`;
}

function coordinate(value, positive, negative) {
  if (!Number.isFinite(value)) return "unknown";
  const direction = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(4)}°${direction}`;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "unknown").replaceAll("_", " ");
}

function metaItem(label, value) {
  const wrapper = document.createElement("div");
  wrapper.append(node("dt", "", label), node("dd", "", value));
  return wrapper;
}

function renderVessels(payload) {
  const container = document.querySelector("#vessel-cards");
  const cards = payload.vessels.map((vessel) => {
    const latest = vessel.latest;
    const card = node("article", "vessel-card");
    card.id = `vessel-${vessel.id}`;

    const top = node("div", "vessel-top");
    const title = document.createElement("div");
    title.append(
      node("p", "vessel-role", String(vessel.role || "").replaceAll("_", " ")),
      node("h3", "vessel-name", vessel.name)
    );
    const status = node(
      "span",
      `status-pill ${vessel.status || ""}`,
      statusLabel(vessel.status)
    );
    top.append(title, status);

    const coordinates = latest
      ? `${coordinate(latest.lat, "N", "S")} · ${coordinate(latest.lon, "E", "W")}`
      : "No verified public fix";
    const meta = node("dl", "vessel-meta");
    meta.append(
      metaItem("Fix age", ageLabel(vessel.age_minutes)),
      metaItem("Speed", latest?.sog == null ? "—" : `${latest.sog} kn`),
      metaItem("Source", latest?.source ?? "—")
    );
    card.append(top, node("p", "coordinates", coordinates), meta);
    return card;
  });
  container.replaceChildren(...cards);

  const pairing = document.querySelector("#pairing");
  if (payload.pairing) {
    pairing.hidden = false;
    pairing.textContent = `KORU ↔ ABEONA · ${payload.pairing.distance_nm} nautical miles apart · observations ${payload.pairing.observations_within_hours}h apart`;
  } else {
    pairing.hidden = true;
    pairing.textContent = "";
  }
}

function renderEvents(payload) {
  const container = document.querySelector("#events");
  if (!payload.events.length) {
    const empty = node("article", "event");
    empty.append(
      node("span", "event-type", "No public events yet"),
      node("h3", "", "The timeline begins with the next verified transition.")
    );
    container.replaceChildren(empty);
    return;
  }

  const eventNodes = payload.events.map((event) => {
    const date = new Date(event.occurred_at);
    const title = event.details?.port
      ? `${event.vessel_name} · ${event.details.port}`
      : `${event.vessel_name} · ${String(event.type).replaceAll("_", " ").toLowerCase()}`;
    const article = node("article", "event");
    const time = node(
      "time",
      "",
      `${date.toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC"
      })} UTC`
    );
    time.dateTime = event.occurred_at;
    article.append(
      time,
      node("h3", "", title),
      node("span", "event-type", String(event.type).replaceAll("_", " "))
    );
    return article;
  });
  container.replaceChildren(...eventNodes);
}

function renderMap(track, latest) {
  if (mapInstance) mapInstance.remove();
  mapInstance = L.map("map", { scrollWheelZoom: false }).setView([15, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(mapInstance);

  const bounds = [];
  const segmentCounts = {};
  track.features.forEach((feature) => {
    const id = feature.properties.vessel_id;
    const coordinates = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (coordinates.length) {
      L.polyline(coordinates, {
        color: COLORS[id] || "#ffffff",
        weight: 4,
        opacity: 0.9
      }).addTo(mapInstance);
      bounds.push(...coordinates);
      segmentCounts[id] = (segmentCounts[id] || 0) + 1;
    }
  });

  latest.vessels.forEach((vessel) => {
    if (!vessel.latest) return;
    const point = [vessel.latest.lat, vessel.latest.lon];
    const popup = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = vessel.name;
    popup.append(name, document.createElement("br"), document.createTextNode(statusLabel(vessel.status)));
    L.circleMarker(point, {
      radius: 8,
      color: "#071c22",
      weight: 3,
      fillColor: COLORS[vessel.id] || "#ffffff",
      fillOpacity: 1
    }).bindPopup(popup).addTo(mapInstance);
    bounds.push(point);
  });
  if (bounds.length) mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });

  const breaks = track.properties?.gap_count ?? Object.values(segmentCounts).reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  document.querySelector("#map-summary").textContent = breaks
    ? `The 30-day trace contains ${breaks} unconnected AIS gap${breaks === 1 ? "" : "s"}. No route is drawn through missing intervals.`
    : "The 30-day trace contains no AIS gap longer than 90 minutes.";
}

async function boot() {
  const vesselCards = document.querySelector("#vessel-cards");
  vesselCards.setAttribute("aria-busy", "true");
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
      latestResponse.json(),
      trackResponse.json(),
      eventsResponse.json()
    ]);

    const activity = latest.source_activity?.aisstream;
    const connected = activity
      ? activity.transport_status === "connected"
      : latest.source_health?.aisstream === "healthy";
    document.querySelector("#source-dot").classList.toggle("healthy", connected);
    const recency = activity
      ? ` · LAST DIRECT FIX ${ageLabel(activity.position_age_minutes).toUpperCase()}`
      : "";
    document.querySelector("#source-health").textContent =
      `AISSTREAM LINK ${connected ? "CONNECTED" : "UNAVAILABLE"}${recency}`;
    document.querySelector("#data-through").textContent =
      `PUBLIC DATA THROUGH ${new Date(latest.public_data_through).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC"
      })} UTC`;
    renderVessels(latest);
    renderEvents(events);
    renderMap(track, latest);
  } catch (error) {
    document.querySelector("#source-health").textContent = "PUBLIC DATA UNAVAILABLE";
    const unavailable = node("article", "vessel-card");
    unavailable.append(
      node("h3", "vessel-name", "Temporarily unavailable"),
      node("p", "", "The last published snapshot could not be loaded.")
    );
    vesselCards.replaceChildren(unavailable);
  } finally {
    vesselCards.setAttribute("aria-busy", "false");
  }
}

boot();
window.setInterval(boot, REFRESH_MS);
