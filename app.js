const COLORS = { koru: "#ff7c5c", abeona: "#62d7c8" };
// Dashes give the support vessel a non-color cue; matches the legend swatch.
const DASHES = { abeona: "10 8" };
const REFRESH_MS = 5 * 60 * 1000;
const STATUS_LABELS = {
  current: "Current",
  stale: "Stale fix",
  signal_gap: "Signal gap",
  source_unavailable: "Source unavailable",
  no_verified_fix: "No verified fix"
};
const NM_PER_RADIAN = 3440.065;
// Below this speed a fix reads as stationary; AIS speed jitters around zero at a mooring.
const STATIONARY_KN = 0.5;
// Fixes closer than this to the last counted point are position noise, not travel.
const MIN_HOP_NM = 0.05;
const TRACE_DAYS = 30;
const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
// AIS MMSI prefixes (maritime identification digits) for the flags in use.
const FLAGS_BY_MID = { "319": "Cayman Islands" };
// From builder announcements and trade press, not from AIS.
const VESSEL_SPECS = {
  koru: [["Type", "Three-masted schooner"], ["Length", "127 m"], ["Built", "Oceanco · 2023"]],
  abeona: [["Type", "Support vessel · helipad"], ["Length", "75 m"], ["Built", "Damen Yachting · 2023"]]
};

let mapInstance = null;
let trackLayer = null;
const vesselMarkers = new Map();
let hasFittedMap = false;
let hasRendered = false;
let lastEvents = null;
let lastStatuses = {};
let eventFilter = "all";

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

function utcLabel(iso) {
  return `${new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  })} UTC`;
}

function hoursLabel(hours) {
  if (!Number.isFinite(hours)) return "an unknown time";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function nauticalMiles(value) {
  return `${Math.round(value).toLocaleString("en-US")} nm`;
}

function distanceNm([lat1, lon1], [lat2, lon2]) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * NM_PER_RADIAN * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isUnderway(latest) {
  return Number.isFinite(latest?.sog) && latest.sog >= STATIONARY_KN;
}

function motionLabel(latest) {
  if (!Number.isFinite(latest?.sog)) return "—";
  return isUnderway(latest) ? `Underway · ${latest.sog.toFixed(1)} kn` : "Stationary";
}

// AIS sends 511 for "no heading" and 360 for "no course". Course over ground
// is only meaningful while moving, so it is the fallback for underway fixes only.
function bearingOf(latest) {
  if (Number.isFinite(latest?.heading) && latest.heading < 360) return latest.heading;
  if (isUnderway(latest) && Number.isFinite(latest.cog) && latest.cog < 360) return latest.cog;
  return null;
}

function headingItem(latest) {
  const wrapper = document.createElement("div");
  const value = node("dd", "");
  const degrees = bearingOf(latest);
  if (degrees == null) {
    value.textContent = "—";
  } else {
    const arrow = node("span", "heading-arrow", "↑");
    arrow.setAttribute("aria-hidden", "true");
    arrow.style.transform = `rotate(${degrees}deg)`;
    const point = COMPASS_POINTS[Math.round(degrees / 45) % 8];
    value.append(arrow, `${Math.round(degrees)}° ${point}`);
  }
  wrapper.append(node("dt", "", "Heading"), value);
  return wrapper;
}

function placeLabel(place) {
  if (!place) return "";
  const name = place.country && place.country !== place.name
    ? `${place.name}, ${place.country}`
    : place.name;
  return place.relation === "in_port"
    ? `In port · ${name}`
    : `Near ${name} · ${place.distance_nm} nm`;
}

function localTimeLabel(timezone) {
  try {
    const time = new Intl.DateTimeFormat([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone.name,
      timeZoneName: "short"
    }).format(new Date());
    return timezone.basis === "nautical" ? `${time} (nautical zone)` : time;
  } catch {
    return "";
  }
}

// Place and time zone come from the collector; older bundles lack them.
function placeLine(vessel) {
  if (!vessel.place && !vessel.timezone?.name) return null;
  const line = node("p", "place-line");
  const place = placeLabel(vessel.place);
  if (place) line.append(node("span", "place-name", place));
  if (vessel.timezone?.name) {
    const time = node("span", "local-time");
    time.dataset.timezone = vessel.timezone.name;
    time.dataset.basis = vessel.timezone.basis || "";
    time.textContent = `Local time ${localTimeLabel(vessel.timezone)}`;
    line.append(time);
  }
  return line;
}

function refreshLocalTimes() {
  document.querySelectorAll(".local-time").forEach((element) => {
    const label = localTimeLabel({
      name: element.dataset.timezone,
      basis: element.dataset.basis
    });
    element.textContent = `Local time ${label}`;
  });
}

function specsFor(vessel) {
  const specs = [...(VESSEL_SPECS[vessel.id] || [])];
  const flag = FLAGS_BY_MID[String(vessel.mmsi || "").slice(0, 3)];
  if (flag) specs.push(["Flag", flag]);
  if (vessel.imo) specs.push(["IMO", vessel.imo]);
  const list = node("dl", "vessel-specs");
  specs.forEach(([label, value]) => list.append(metaItem(label, value)));
  return list;
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
      metaItem("Motion", motionLabel(latest)),
      headingItem(latest),
      metaItem("Source", latest?.source ?? "—")
    );
    card.append(
      top,
      node("p", "coordinates", coordinates),
      ...[placeLine(vessel)].filter(Boolean),
      meta,
      specsFor(vessel)
    );
    return card;
  });
  container.replaceChildren(...cards);

  const pairing = document.querySelector("#pairing");
  const located = payload.vessels.filter((vessel) => vessel.latest);
  if (payload.pairing) {
    pairing.hidden = false;
    pairing.textContent = `KORU ↔ ABEONA · ${payload.pairing.distance_nm} nautical miles apart · observations ${payload.pairing.observations_within_hours}h apart`;
  } else if (located.length === 2) {
    // The collector only pairs fixes taken close together in time; otherwise
    // compare the last verified fixes and say how far apart in time they are.
    const [first, second] = located;
    const miles = distanceNm(
      [first.latest.lat, first.latest.lon],
      [second.latest.lat, second.latest.lon]
    );
    const hoursApart =
      Math.abs(new Date(first.latest.observed_at) - new Date(second.latest.observed_at)) / 3.6e6;
    pairing.hidden = false;
    pairing.textContent =
      `${first.name} ↔ ${second.name} · about ${nauticalMiles(miles)} apart` +
      (hoursApart >= 1 ? ` · last fixes ${hoursLabel(hoursApart)} apart` : "");
  } else {
    pairing.hidden = true;
    pairing.textContent = "";
  }
}

// One timeline row per signal-gap episode: a resolved gap shows as its
// restore event with the total length; an unresolved gap stays as the gap.
function timelineEntries(events, statuses) {
  const episodeKey = (event) => `${event.vessel_id}:${event.details?.episode_id}`;
  const restored = new Set(
    events.filter((event) => event.type === "SIGNAL_RESTORED").map(episodeKey)
  );
  return events.flatMap((event) => {
    if (event.type === "SIGNAL_RESTORED") {
      return [{
        event,
        title: `${event.vessel_name} · signal back after ${hoursLabel(event.details?.gap_hours)}`,
        tag: "Signal gap · resolved"
      }];
    }
    if (event.type === "SIGNAL_GAP") {
      if (event.details?.episode_id != null && restored.has(episodeKey(event))) return [];
      const since = event.details?.last_observation_at;
      const ongoing = statuses[event.vessel_id] === "signal_gap";
      return [{
        event,
        title: since
          ? `${event.vessel_name} · no signal since ${utcLabel(since)}`
          : `${event.vessel_name} · signal gap`,
        tag: ongoing ? "Signal gap · ongoing" : "Signal gap"
      }];
    }
    return [{
      event,
      title: event.details?.port
        ? `${event.vessel_name} · ${event.details.port}`
        : `${event.vessel_name} · ${String(event.type).replaceAll("_", " ").toLowerCase()}`,
      tag: String(event.type).replaceAll("_", " ")
    }];
  });
}

function renderEvents(payload, statuses) {
  const container = document.querySelector("#events");
  const entries = timelineEntries(payload.events, statuses).filter(
    ({ event }) => eventFilter === "all" || event.vessel_id === eventFilter
  );
  if (!entries.length) {
    const empty = node("article", "event");
    empty.append(
      node("span", "event-type", "No public events yet"),
      node(
        "h3",
        "",
        payload.events.length
          ? "No events for this vessel in the public window."
          : "The timeline begins with the next verified transition."
      )
    );
    container.replaceChildren(empty);
    return;
  }

  const eventNodes = entries.map(({ event, title, tag }) => {
    const article = node("article", "event");
    const time = node("time", "", utcLabel(event.occurred_at));
    time.dateTime = event.occurred_at;
    article.append(time, node("h3", "", title), node("span", "event-type", tag));
    return article;
  });
  container.replaceChildren(...eventNodes);
}

function setEventFilter(vesselId) {
  eventFilter = vesselId;
  document.querySelectorAll(".timeline-filter button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.vessel === vesselId));
  });
  if (lastEvents) renderEvents(lastEvents, lastStatuses);
}

// Distance counts only movement along verified segments, so it undercounts
// any passage made during a signal gap; coverage says how much that is.
function traceStats(track) {
  const stats = {};
  track.features.forEach((feature) => {
    const { vessel_id: id, started_at: startedAt, ended_at: endedAt } = feature.properties;
    const entry = (stats[id] ||= { name: feature.properties.name || id, miles: 0, coveredMs: 0 });
    if (startedAt && endedAt) entry.coveredMs += new Date(endedAt) - new Date(startedAt);
    let anchor = null;
    feature.geometry.coordinates.forEach(([lon, lat]) => {
      if (!anchor) {
        anchor = [lat, lon];
        return;
      }
      const hop = distanceNm(anchor, [lat, lon]);
      if (hop >= MIN_HOP_NM) {
        entry.miles += hop;
        anchor = [lat, lon];
      }
    });
  });
  return stats;
}

function renderStats(track) {
  const windowMs = TRACE_DAYS * 24 * 3.6e6;
  const items = Object.entries(traceStats(track)).map(([id, entry]) => {
    const item = node("article", `trace-stat ${id}`);
    const coverage = Math.min(100, Math.round((entry.coveredMs / windowMs) * 100));
    const facts = node("dl", "");
    facts.append(
      metaItem("Verified distance", nauticalMiles(entry.miles)),
      metaItem("AIS coverage", `${coverage}%`)
    );
    item.append(node("h3", "", entry.name), facts);
    return item;
  });
  document.querySelector("#trace-stats").replaceChildren(...items);
}

function ensureMap() {
  if (mapInstance) return;
  mapInstance = L.map("map", { scrollWheelZoom: false }).setView([15, 0], 2);
  // Standard OSM tiles, darkened in CSS (.dark-tiles) to match the page.
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    className: "dark-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(mapInstance);
  // Markers live above the tracks even though tracks are redrawn on every refresh.
  mapInstance.createPane("vessels").style.zIndex = 450;
  trackLayer = L.layerGroup().addTo(mapInstance);
}

function markerPopup(vessel) {
  const popup = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = vessel.name;
  popup.append(name, document.createElement("br"), document.createTextNode(statusLabel(vessel.status)));
  return popup;
}

// The map is built once; refreshes update it in place so a reader's zoom,
// pan and open popup survive the five-minute reload.
function renderMap(track, latest) {
  ensureMap();
  trackLayer.clearLayers();

  const bounds = [];
  const segmentCounts = {};
  track.features.forEach((feature) => {
    const id = feature.properties.vessel_id;
    const coordinates = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    if (coordinates.length) {
      L.polyline(coordinates, {
        color: COLORS[id] || "#ffffff",
        dashArray: DASHES[id],
        weight: 4,
        opacity: 0.9
      }).addTo(trackLayer);
      bounds.push(...coordinates);
      segmentCounts[id] = (segmentCounts[id] || 0) + 1;
    }
  });

  const shown = new Set();
  latest.vessels.forEach((vessel) => {
    if (!vessel.latest) return;
    const point = [vessel.latest.lat, vessel.latest.lon];
    let marker = vesselMarkers.get(vessel.id);
    if (marker) {
      marker.setLatLng(point).setPopupContent(markerPopup(vessel));
    } else {
      marker = L.circleMarker(point, {
        pane: "vessels",
        radius: 8,
        color: "#f3efe5",
        weight: 2,
        fillColor: COLORS[vessel.id] || "#ffffff",
        fillOpacity: 1
      })
        .bindPopup(markerPopup(vessel))
        .bindTooltip(vessel.name, {
          permanent: true,
          direction: "right",
          offset: [10, 0],
          className: "vessel-label"
        })
        .addTo(mapInstance);
      vesselMarkers.set(vessel.id, marker);
    }
    shown.add(vessel.id);
    bounds.push(point);
  });
  vesselMarkers.forEach((marker, id) => {
    if (shown.has(id)) return;
    marker.remove();
    vesselMarkers.delete(id);
  });
  if (!hasFittedMap && bounds.length) {
    mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
    hasFittedMap = true;
  }

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
      `PUBLIC DATA THROUGH ${utcLabel(latest.public_data_through)}`;
    renderVessels(latest);
    lastEvents = events;
    lastStatuses = Object.fromEntries(latest.vessels.map((vessel) => [vessel.id, vessel.status]));
    renderEvents(events, lastStatuses);
    renderMap(track, latest);
    renderStats(track);
    hasRendered = true;
  } catch (error) {
    document.querySelector("#source-dot").classList.remove("healthy");
    if (hasRendered) {
      // Keep the last good snapshot on screen; its "data through" time still applies.
      document.querySelector("#source-health").textContent =
        "REFRESH FAILED · SHOWING LAST LOADED SNAPSHOT";
      return;
    }
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

document.querySelectorAll(".timeline-filter button").forEach((button) => {
  button.addEventListener("click", () => setEventFilter(button.dataset.vessel));
});
boot();
window.setInterval(boot, REFRESH_MS);
window.setInterval(refreshLocalTimes, 30 * 1000);
