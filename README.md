# Egg Event Lab

**Current release: v0.2**

Egg Event Lab is a static browser application for analyzing and forecasting Egg, Inc. event rotations. It combines the public Wasmegg event history with local corrections, empirical gap distributions, recency weighting, and known same-day scheduling constraints.

The project has no build step and no runtime dependencies. It can be hosted directly on GitHub Pages, Netlify, or any basic static web server.

## Features

- Separate tiles for the current Pacific event day
- Side-by-side Today’s Events and Tomorrow’s Events panels, with tomorrow’s highest-probability Ultra and Non-Ultra picks
- Configurable 1–120 day forward forecast window that begins the day after the reference date
- Per-event selection for all daily forecast rotations
- Separate Sunday-only double-capacity forecast with independent Ultra / Non-Ultra selection and a configurable number of weeks (4 Sundays by default)
- Separate Ultra and Non-Ultra rotations
- Most-likely-next-date estimates with a 400-day look-ahead
- Gap-history explorer with raw and weighted frequencies
- Rolling recency weights:
  - under 1 year: 3×
  - 1–2 years: 2×
  - 2+ years: 0.5×
- Conditional gap-hazard modeling
- Monte Carlo simulation with same-day event conflicts
- Calendar view and local event overrides
- JSON import/export for browser state
- Automatic Wasmegg synchronization from January 1, 2024 forward
- July 14 / Egg Day exclusion from model training

## Event model

The model treats every supported rotation as a first-class event. Fourteen daily rotations share the main forecast, while double capacity remains in its own Sunday-only forecast:

| Family | Non-Ultra | Ultra |
| --- | --- | --- |
| Housing | Non-Ultra Housing | Ultra Housing |
| Shipping | Non-Ultra Shipping | Ultra Shipping |
| Drones | Non-Ultra Drones | Ultra Drones |
| 2× Boost Duration | Non-Ultra 2× Boost Duration | Ultra 2× Boost Duration |
| 2× Gifts | Non-Ultra 2× Gifts | Ultra 2× Gifts |
| 15% Off Shells | Non-Ultra 15% Off Shells | Ultra 15% Off Shells |
| 3× Fueling | Non-Ultra 3× Fueling | Ultra 3× Fueling |
| Mission capacity | Non-Ultra 2× Capacity | Ultra 2× Capacity |

### Scheduling rules currently modeled

- Tuesday–Thursday has one shared Non-Ultra event slot across Housing, Shipping, Drones, 2× Boost Duration, 2× Gifts, 15% Off Shells, and 3× Fueling, so those seven Non-Ultra rotations are mutually exclusive and their daily probabilities sum to 100%.
- The Ultra versions of those four event types likewise conflict with Ultra housing, shipping, and drones.
- From May 4, 2026 forward, exactly one modeled Ultra event is assigned to each eligible every-other-Pacific-day cadence slot; Ultra 2× Capacity can take that slot only when the date is also Sunday.
- Ultra same-rotation gaps ending in that cadence era are used for training only when their length aligns to the 2-day cadence; misaligned gaps are ignored as schedule-transition / anniversary artifacts.
- Ultra and Non-Ultra versions of the same tracked event family cannot occur on the same day.
- No additional same-day exclusivity among Boost Duration, Gifts, Shells, and Fueling is assumed unless future data establishes it.
- The optional 16-day prediction cap applies to Non-Ultra housing, shipping, and drones.
- The optional observed weekday rule limits those same rotations to Tuesday–Thursday.
- The Tomorrow’s Events panel treats the regular Non-Ultra Friday–Monday schedule as fixed: 70% Off Common Research on Friday, a Prestige Bonus on Saturday, alternating 35% Off Epic Research / 30% Off Crafting on Sunday, and 2× Earnings on Monday.
- Double-capacity events are restricted to Pacific-time Sundays and are displayed only on Sunday rows in their dedicated forecast. Non-Ultra 2× Capacity is an independent Sunday event and can occur alongside the regular fixed Non-Ultra Sunday event.
- The optional Ultra rule excludes a 5-day repeat gap; the every-other-day cadence independently blocks all odd-day regular Ultra returns after May 4, 2026.
- Every July 14 is excluded from training and current-gap resets because Egg Day uses a special event schedule.

The raw history is retained even when a prediction rule is enabled. Rules affect forecasts and gap-training eligibility; they do not rewrite or delete source data.

## Prediction method

For a candidate gap `g`, the base probability is the empirical conditional hazard:

```text
P(hit at g | survived to g)
  = weighted count(g) / weighted count(historical gaps >= g)
```

Historical observations are weighted by age relative to the forecast date. The selected forecast date is treated as the reference day: confirmed events on that day immediately reset their rotation counters to 0 and their newly completed gaps are included in the model. The configurable **Next X days** forecast begins on the following day. The application then runs 3,000 deterministic Monte Carlo simulations across that forward window. Each simulated hit resets its rotation, and same-day conflicts are resolved before the result is counted.

The Most Likely Next Date cards use the same model with a dedicated 1,200-run first-hit simulation so the larger daily event set stays responsive.

This is an empirical predictor, not an official Egg, Inc. schedule or API.

## Wasmegg data

The application reads the public event dataset used by the Wasmegg Events Calendar:

```text
periodicals/data/events.json
```

Supported records dated January 1, 2024 or later are mapped as follows:

| Wasmegg type | Egg Event Lab rotation |
| --- | --- |
| `hab-sale` | Housing |
| `vehicle-sale` | Shipping |
| `drone-boost` | Drones |
| `mission-capacity` at 2× | Double Capacity |
| `boost-duration` at 2× | 2× Boost Duration, tier from `ultra` |
| `gift-boost` at 2× | 2× Gifts, tier from `ultra` |
| `shell-sale` at 0.85× | 15% Off Shells, tier from `ultra` |
| `mission-fuel` at 3× | 3× Fueling, tier from `ultra` |

The Wasmegg `ultra` field determines the Ultra/Non-Ultra classification. Future-dated records are ignored until their event date arrives. Successful syncs are cached in localStorage; if a later sync fails, the cached data remains available.

A local confirmation overrides all tracked event rotations for that date. Wasmegg remains the default source for every supported event type when no local override exists.

## Project layout

```text
.
├── app.js                  # Small browser entry point
├── index.html              # Application shell
├── styles.css              # Application styles
├── data/
│   └── seed-events.js      # Offline fallback event history
├── src/
│   ├── config.js           # Version, event definitions, constants, defaults
│   ├── utils.js            # Date, formatting, random, and HTML helpers
│   ├── store.js            # Browser state, event repository, gap statistics
│   ├── wasmegg.js          # Wasmegg mapping, normalization, and synchronization
│   ├── model.js            # Hazards, conflicts, and forecast simulations
│   └── ui.js               # DOM rendering and interaction handlers
├── tests/
│   └── core.test.js        # Core rules and data-normalization tests
├── CHANGELOG.md
├── VERSION
├── netlify.toml
└── .gitignore
```

The files use a small `window.EggEventLab` namespace rather than ES module imports so the application can still be opened directly from disk without a build tool or local development server.

## Run locally

You can open `index.html` directly in a browser. For a normal local web-server workflow:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.


## Time zones and clock

The prediction model uses the Egg, Inc. daily event boundary at **9:00 AM America/Los_Angeles**. On startup the app requests its own page and reads the HTTP `Date` header, so the current model day is based on the hosting server clock rather than the visitor's device clock. If the app is opened directly from disk or the server clock cannot be read, it falls back to the browser clock and shows that state in the header.

Forecast and historical event dates are converted automatically to the browser's detected IANA time zone for display. The underlying model, weekday rules, and gap calculations always remain on the Pacific event date. When the viewer's local calendar date differs from the Pacific event date, the UI shows both dates to avoid ambiguity.

## Tests

The test suite uses Node's built-in test runner and requires no packages:

```bash
node --test tests/core.test.js
```

Current tests cover release/version consistency, date arithmetic, Egg Day exclusion, event-conflict rules, Wasmegg event mappings, Wasmegg date filtering, and rolling recency bands.

## Deploy

### GitHub Pages

Commit the project contents at the repository root. In GitHub, enable **Settings → Pages → Deploy from a branch**, select the main branch, and publish from **/(root)**.

### Netlify

The repository can be connected directly to Netlify, or the folder can be uploaded through Netlify Drop. The included `netlify.toml` publishes the repository root.

## Local data and backups

Application state is stored in the browser under the `egg-event-lab-v1` localStorage key. Use **Export** before changing browsers or devices. The exported JSON contains local overrides, model settings, forecast preferences, and the latest Wasmegg cache.

The fallback history is maintained separately in `data/seed-events.js` and is used only when synced/cached Wasmegg data is unavailable.

## Versioning

The current release is **v0.2**. Public release numbers are stored in `src/config.js` and `VERSION`. The JSON export schema has its own independent version so application releases do not unnecessarily invalidate saved data.

`CHANGELOG.md` records public release changes.

## License

No software license is included yet. Add one before granting third parties reuse or redistribution rights.

### Fallback data

The bundled `data/seed-events.js` file is a fallback subset used when the app has not completed a Wasmegg sync. A successful Wasmegg sync is authoritative and supplies the full supported history from January 1, 2024 forward. On each successful sync, the app audits every bundled seed date against the normalized Wasmegg data and reports any stale or incorrect seed dates in the browser console.

