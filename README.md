# Maritime AIS Tracker

A live OSINT data pipeline that tracks named vessels from their public **AIS**
(Automatic Identification System) broadcasts. It checks every position fix before
using it, labels gaps in coverage honestly, and publishes a static, delayed and
sanitized dataset to GitHub Pages. The current example vessels are the superyacht
**KORU** (IMO 9857298) and its support vessel **ABEONA**.

This repository is the **public output**: the static site and the data files it
renders. The collector that produces them runs privately on a home server; this README
describes how it works.

## Pipeline

```
AISStream websocket (primary)     scheduled fallback sources
            │                                │
            └───────── collector ───────────┘   long-running systemd service
                          │  validates, dedupes, rejects impossible fixes
                          ▼
                tracking engine (SQLite)
          observations · signal episodes · geofence events
                          │
                          ▼
               public export (every 5 min)
          15-minute delay · sanitize · schema check
                          │  atomic, timestamp-aware git push
                          ▼
            this repo  ──►  GitHub Pages (Leaflet map, RSS)
```

A separate health check runs every 10 minutes. It covers the collector heartbeat, the
export's freshness and the live site, and raises an alert instead of letting a stall go
unnoticed.

## Data contract

| File | Contents |
|---|---|
| `data/latest.json` | Latest verified fix per vessel, its age, the health and last accepted fix of each source, and `public_data_through` |
| `data/track.geojson` | Track segments as GeoJSON `LineString`s, split wherever there is a coverage gap |
| `data/events.json` | Signal-gap / signal-restored episodes and port arrivals and departures, each with a confidence value |
| `data/events.rss` | The same events as an RSS feed |

Every file carries `schema_version`, and the export checks the bundle before it is
pushed. All four files are replaced together, so the site never shows a half-updated
dataset.

## Design rules

- **Only public broadcasts.** Positions come only from AIS messages that the vessels
  themselves broadcast, as maritime safety rules require. The pipeline never guesses
  or interpolates coordinates.
- **Coverage gaps are labeled, never hidden.** A *signal gap* means the collector is
  healthy but no verified fix arrived. *Source unavailable* means it can't tell silence
  from an outage. The site shows which one applies instead of drawing a confident line.
- **Delayed and sanitized.** The public data trails the collector by a fixed 15 minutes
  (`public_delay_minutes`). It never includes credentials, raw logs, the database or
  real-time observations.
- **Vessels, not people.** The pipeline tracks hulls by MMSI and IMO number. Ownership
  appears only where it has been publicly reported, and is labeled as reported
  (`association`), not confirmed.

## Third-party

Leaflet is bundled under the BSD 2-Clause License; see `LICENSE-leaflet.txt`.

Vessel photos in `assets/` are by Conmat13 on Wikimedia Commons, licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and resized for
the web: [`koru.jpg`](https://commons.wikimedia.org/wiki/File:Koru_Superyacht.jpg)
and [`abeona.jpg`](https://commons.wikimedia.org/wiki/File:Abeona.jpg). The
resized copies are shared under the same licence.
