# Egg Event Lab

**Current release: v0.6**

Egg Event Lab is a static browser application for analyzing and forecasting Egg, Inc. event rotations. It combines the public Wasmegg event history with local corrections, empirical gap distributions, recency weighting, and known same-day scheduling constraints.

The project has no build step and no runtime dependencies. It can be hosted directly on GitHub Pages, Netlify, or any basic static web server.

## Features

- Separate Today and Tomorrow tiles displayed in the viewer’s local date/time context
- A separate Mission Capacity Boost tile in Tomorrow’s Events, visible only when at least one tier has a positive chance; eligible Ultra and Non-Ultra percentages are shown separately
- Side-by-side Today’s Events and Tomorrow’s Events panels, with tomorrow’s highest-probability Ultra and Non-Ultra picks
- Configurable 1–120 row forward forecast that begins after the reference date and skips dates where every selected event is 0%
- Per-event selection for all daily forecast rotations
- Separate Sunday-only Mission Capacity Boost forecast with independent Ultra / Non-Ultra selection and a configurable number of weeks (4 Sundays by default)
- Separate Ultra and Non-Ultra rotations
- Collapsible most-likely-next-date and rotation-status sections, with a 400-day next-hit look-ahead
- Gap-history explorer with raw and weighted frequencies
- Rolling recency weights:
  - under 1 year: 3×
  - 1–2 years: 2×
  - 2+ years: 0.5×
- Conditional gap-hazard modeling
- Monte Carlo simulation with same-day event conflicts
- Calendar view with configurable confirmed/predicted overlays, tier filters, and a minimum probability threshold
- Local event overrides; Record a Day uses the viewer’s local display date while mapping back to the Pacific event date internally
- Lazy-loaded Data table that renders records in 100-row batches
- Background forecast calculations, visible updating status, and a yielding fallback when Web Workers are unavailable
- Historical forecasts restricted to data through their selected reference day
- Independent regular-schedule calendar layer, including past dates
- Inline skipped-date separators and a Current event day shortcut
- JSON import/export for browser state
- Automatic Wasmegg synchronization from January 1, 2024 forward
- July 14 / Egg Day exclusion from model training

## Event model

The model treats every supported rotation as a first-class event. Fourteen daily rotations share the main forecast, while Mission Capacity Boost remains in its own Sunday-only forecast:

| Family | Non-Ultra | Ultra |
| --- | --- | --- |
| Hab Sale | Non-Ultra Hab Sale | Ultra Hab Sale |
| Vehicle Sale | Non-Ultra Vehicle Sale | Ultra Vehicle Sale |
| Generous Drones | Non-Ultra Generous Drones | Ultra Generous Drones |
| Boost Time+ | Non-Ultra Boost Time+ | Ultra Boost Time+ |
| Generous Gifts | Non-Ultra Generous Gifts | Ultra Generous Gifts |
| Shell Sale | Non-Ultra Shell Sale | Ultra Shell Sale |
| Mission Fuel Boost | Non-Ultra Mission Fuel Boost | Ultra Mission Fuel Boost |
| Mission Capacity Boost | Non-Ultra Mission Capacity Boost | Ultra Mission Capacity Boost |

### Scheduling rules currently modeled

- Tuesday–Thursday has one shared Non-Ultra event slot across Hab Sale, Vehicle Sale, Generous Drones, Boost Time+, Generous Gifts, Shell Sale, and Mission Fuel Boost, so those seven Non-Ultra rotations are mutually exclusive and their daily probabilities sum to 100%.
- The Ultra versions of those seven event types likewise conflict with Ultra Hab Sale, Vehicle Sale, and Generous Drones.
- From May 4, 2026 forward, exactly one modeled Ultra event is assigned to each eligible every-other-Pacific-day cadence slot; Ultra Mission Capacity Boost can take that slot only when the date is also Sunday.
- Ultra same-rotation gaps ending in that cadence era are used for training only when their length aligns to the 2-day cadence; misaligned gaps are ignored as schedule-transition / anniversary artifacts.
- Ultra and Non-Ultra versions of the same tracked event family cannot occur on the same day.
- No additional same-day exclusivity among Boost Time+, Generous Gifts, Shell Sale, and Mission Fuel Boost is assumed unless future data establishes it.
- Non-Ultra Hab Sale and Vehicle Sale have a 6-day minimum gap; Non-Ultra Generous Drones has a 7-day minimum.
- All eight Non-Ultra rotations use soft gap estimates instead of hard maximum-gap deadlines, including Mission Capacity Boost. An overdue event stays possible on eligible dates without being forced into the schedule.
- The optional observed weekday rule limits those same rotations to Tuesday–Thursday.
- The Tomorrow’s Events panel treats the regular Non-Ultra Friday–Monday schedule as fixed: Research Sale on Friday, Prestige Boost on Saturday, alternating Epic Research Sale / Crafting Sale on Sunday, and Cash Boost on Monday.
- Mission Capacity Boost events are restricted to Pacific-time Sundays and are displayed only on Sunday rows in their dedicated forecast. Non-Ultra Mission Capacity Boost is an independent Sunday event and can occur alongside the regular fixed Non-Ultra Sunday event.
- Every July 14 is excluded from training and current-gap resets because Egg Day uses a special event schedule.

The old 16-day-cap setting is retired and removed when saved settings are loaded or imported. The raw history is retained even when a prediction rule is enabled. Rules affect forecasts and gap-training eligibility; they do not rewrite or delete source data.

## Prediction method

The predictor is based on what actually happened in past event rotations. At a high level:

1. It measures the number of days between previous occurrences of each event.
2. Recent history counts more than older history.
3. It estimates how likely an event is to end its current gap on each eligible future date. Non-Ultra estimates also allow unseen gaps and waits beyond the historical maximum.
4. It applies the scheduling rules we have observed, including guaranteed event slots, Ultra cadence, weekday restrictions, same-day conflicts, Sunday-only Mission Capacity Boost, and the Egg Day exclusion.
5. It simulates the future schedule thousands of times and turns those outcomes into the percentages shown in the app.

Non-Ultra maximum gaps are observations, not deadlines. Missing history receives a weak prior, so one well-documented rotation cannot automatically exclude the others. Minimum-gap and weekday restrictions still determine which dates are eligible.

The percentages are therefore estimates from historical behavior and the currently enabled rules; they are not an official Egg, Inc. schedule.

<details>
<summary><strong>Technical model details</strong></summary>

For a gap length `g`, the base estimate is a conditional hazard: among historical gaps that lasted at least `g` days, how many ended exactly at `g`?

```text
P(hit at gap g | event has not already hit)
  = weighted count(g) / weighted count(historical gaps >= g)
```

Historical observations are weighted by age. The selected forecast date is the reference day; confirmed events on that date immediately reset their rotation and add their newly completed gap to the training history. **Next X Days** begins after the reference date and skips rows where every selected event is 0%.

For all modeled events, the raw hazard is smoothed as `(exactWeight + 3 × prior) / (survivingWeight + 3)`. The prior is the inverse of the weighted average gap measured in eligible opportunities, capped at 0.5. Its weight of 3 is equivalent to one observation in the default most-recent recency band. When no completed gaps exist, the initial mean is 14 days for daily rotations or 28 days for Sunday capacity events. These are fallback assumptions, not learned scheduling rules.

Beyond the longest observed gap, the estimate starts from the smoothed hazard at that maximum and increases exponentially toward 1 on a timescale equal to the weighted mean gap. The raw hazard is capped at 0.95. The shared event pools then normalize compatible choices, so these raw weights are not the final displayed percentages. This smoothing is a modeling choice that has not yet been calibrated by a full historical backtest. Ultra events use the same smoothing, with eligible opportunities every two days (every other Sunday for Ultra capacity). Cadence, Sunday restrictions, minimum gaps, and cross-tier conflicts still apply. Saved public forecasts remain unchanged.

The main forecast uses 3,000 deterministic Monte Carlo runs. Each run advances one day at a time, applies eligibility and conflict rules, resets rotations after simulated hits, and records which events occur. The Most Likely Next Date cards use a separate 1,200-run first-hit simulation to keep the interface responsive.

</details>

## Wasmegg data

The application reads the public event dataset used by the Wasmegg Events Calendar:

```text
periodicals/data/events.json
```

Supported records dated January 1, 2024 or later are mapped as follows:

| Wasmegg type | Egg Event Lab rotation |
| --- | --- |
| `hab-sale` | Hab Sale |
| `vehicle-sale` | Vehicle Sale |
| `drone-boost` | Generous Drones |
| `mission-capacity` at 2× | Mission Capacity Boost |
| `boost-duration` at 2× | Boost Time+, tier from `ultra` |
| `gift-boost` at 2× | Generous Gifts, tier from `ultra` |
| `shell-sale` at 0.85× | Shell Sale, tier from `ultra` |
| `mission-fuel` at 3× | Mission Fuel Boost, tier from `ultra` |

The Wasmegg `ultra` field determines the Ultra/Non-Ultra classification. Future-dated records are ignored until their event date arrives. Successful syncs are cached in localStorage; if a later sync fails, the cached data remains available.

A local confirmation overrides all tracked event rotations for that date. Record a Day accepts only past or current event days; older imported future entries are retained but excluded from forecasts whose reference day precedes them. Wasmegg remains the default source for every supported event type when no local override exists.

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
│   ├── clock.js            # Server-clock sync and Pacific event-day rollover
│   ├── store.js            # Browser state, event repository, gap statistics
│   ├── wasmegg.js          # Wasmegg mapping, normalization, and synchronization
│   ├── model.js            # Hazards, conflicts, and forecast simulations
│   ├── forecast-worker.js  # Background simulation runner
│   ├── forecast-service.js # Async jobs, cancellation, caching, and yielding fallback
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

Forecast and historical event dates are converted automatically to the browser's detected IANA time zone for display. The underlying model, weekday rules, and gap calculations always remain on the Pacific event date. The Record a Day date picker also uses the local display date and maps it back to the matching Pacific event date internally. When the viewer's local calendar date differs from the Pacific event date, the UI shows both dates where useful to avoid ambiguity.

## Tests

The test suite uses Node's built-in test runner and requires no packages:

```bash
node --test tests/*.test.js
```

Tests cover release consistency, date arithmetic, Egg Day exclusion, conflicts, Wasmegg mappings, recency weights, historical data isolation, deterministic forecast horizons, and equivalence of cooperative and synchronous simulations.

## Deploy

### GitHub Pages

Commit the project contents at the repository root. In GitHub, enable **Settings → Pages → Deploy from a branch**, select the main branch, and publish from **/(root)**.

### Netlify

The repository can be connected directly to Netlify, or the folder can be uploaded through Netlify Drop. The included `netlify.toml` publishes the repository root.

## Local data and backups

Application state is stored in the browser under the `egg-event-lab-v1` localStorage key. Use **Export** before changing browsers or devices. The exported JSON contains local overrides, model settings, forecast preferences, and the latest Wasmegg cache.

The fallback history is maintained separately in `data/seed-events.js` and is used only when synced/cached Wasmegg data is unavailable.

## Versioning

The current release is **v0.6**. Public release numbers are stored in `src/config.js` and `VERSION`. The JSON export schema has its own independent version so application releases do not unnecessarily invalidate saved data.

`CHANGELOG.md` records public release changes.

## License

No software license is included yet. Add one before granting third parties reuse or redistribution rights.

### Fallback data

The bundled `data/seed-events.js` file is a fallback subset used when the app has not completed a Wasmegg sync. A successful Wasmegg sync is authoritative and supplies the full supported history from January 1, 2024 forward. On each successful sync, the app audits every bundled seed date against the normalized Wasmegg data and reports any stale or incorrect seed dates in the browser console.


## v0.5 reference dates and historical forecasts

The reference picker uses the **Pacific event date**, with the day rolling over at 9:00 AM America/Los_Angeles. Forecast rows and calendar cells use the viewer’s local display date. The reference summary shows both dates when they differ. **Current event day** returns the picker to the synchronized clock’s event day (or browser fallback). Selecting a date pins it: automatic synchronization and event-day rollover do not move it until Current event day is selected again.

Today’s and Tomorrow’s **Live** panels always describe the current event day and the following day. They are independent of the forecast reference.

Every simulation receives an isolated snapshot containing only history through its reference day. Later Wasmegg events, manual confirmations, and cadence anchors are excluded. Random seeds use that effective history and model settings, not the latest sync timestamp. Thus, adding later events cannot change an earlier forecast. Corrections to earlier history, settings changes, and model updates can still change a historical replay; the app does not archive the exact forecasts originally displayed.

Future confirmations are not a scenario engine. The app does not condition earlier simulated paths on an event entered in the future. Existing imported future entries remain stored, but do not affect a forecast until its reference date reaches them.

The calendar can show historical predictions alongside subsequently confirmed outcomes; confirmation does not suppress the replay overlay.

The calendar’s **Regular schedule** toggle is independent of Predictions and Confirmed. It reconstructs the current weekly pattern on past and future dates from 2024 onward, excluding Egg Day. Entries are labeled **Scheduled**, not confirmed observations; historical exceptions and schedule changes may differ. Shifted entries include their Pacific date alongside the local calendar date.

Calculations use a Web Worker when available. Direct-file use and browsers without workers use the same simulation in short yielding batches. Previous results remain visible while **Updating predictions…** is shown. Superseded requests are canceled and cannot overwrite newer selections. No build step or third-party runtime dependency is required.


### v0.6: shared predictions and accuracy

Public predictions, downloaded history, and scores are maintained by GitHub Actions. The app reads `data/shared/official.json` directly from the repository’s `main` branch, so results do not depend on a browser being open or a new site deployment. Personal settings, cached history, imported browser archives, and manual overrides do not affect public scores. Browser archives from earlier v0.6 builds remain exportable but are no longer added to or used for public scoring.

#### Set up once

1. Copy this release into the root of BroadSword13/Egg-Event-Prediction, including `.github/workflows/shared-predictions.yml` and `scripts`. The workflow creates `data/shared` automatically if needed. Keep your existing `.git` directory. Commit and push to the default branch.
2. In GitHub → Actions, enable workflows if prompted. Select **Update shared predictions** and use **Run workflow** for an initial check. The workflow requests `contents: write`; repository or organization policy and branch protection must permit its data commits. Do not bypass protections; if your repository requires pull requests, adjust the publishing design before enabling automatic writes.
3. Confirm that the run succeeds and commits `data/shared/official.json` and `data/shared/events.json`. The next runs build stability observations before forecasts become eligible.
4. Deploy this app release as usual. If the repository name or default branch differs, update `SOURCE` in `src/shared.js`. This direct raw-GitHub URL requires a public repository; never add a private access token to browser code.

The hourly schedule runs at minute 17 UTC, with manual dispatch also available. GitHub can delay or skip scheduled runs. The script determines the actual Pacific event day when it executes; it cannot backfill a missed pre-release prediction. Scheduled workflows must be on the default branch. GitHub may disable scheduled workflows in inactive public repositories, so check Actions if the app reports stale data. See [GitHub’s schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

#### Forecast capture and delayed source data

- Poll history hourly. Save a forecast during the last six hours before the next 9 AM Pacific release, with a strict fifteen-minute safety margin checked again after calculation. Daylight-saving time is handled by the same Pacific-time helpers as the app.
- Use default model settings and no personal overrides. Record the timestamp, model version, source code commit, source date, settings, and input hash. The first eligible forecast is frozen. A forecast marked incomplete may be improved only before the cutoff.
- Keep the exact input history for each saved forecast as a compressed JSON snapshot in `data/shared/inputs`; keep the latest complete downloaded response in `data/shared/events.json`.
- The source has no authoritative completion flag. Our conservative heuristic requires at least one hour since release, identical day records on checks separated by at least one hour, a recognized regular Non-Ultra event, and a recognized Ultra event when cadence expects one. Missing or partial data remains pending. This cannot prove completeness, particularly for optional Sunday capacity; later corrections are rechecked and regraded. An actual schedule exception that omits an expected tier remains pending and needs investigation rather than being silently scored as a miss.
- Forecast eligibility requires seven recent input days to pass those checks, excluding Egg Day. Incomplete forecasts can be displayed but never count toward the public score. A source failure or major regression fails the workflow without replacing shared data. There are no invented forecasts for dates before setup.
- Later corrections change outcomes and scores, never a frozen forecast. Changed days must settle again. Only the public source contributes official outcomes.

The app refreshes shared data every five minutes while open and shows the last update time. Unavailable or stale shared data is labeled; local data is never substituted for the public score. Today’s cards use the public saved probabilities when present, including an incomplete-history label where needed. Without a saved forecast, they show a clearly labeled reconstruction using history through yesterday. Reconstructions are unscored and may change with model settings or history corrections.

#### Score definition

The panel offers trailing 30, 90, and 180 calendar days. For each eligible tier/day, the score is `100 × (1 − sum((probability − outcome)²) / 2)`, averaged across scored tier predictions. This normalized multiclass Brier score ranges from 0 to 100; it is not a hit rate. Fixed weekly Non-Ultra events, Egg Day, and correctly predicted Ultra off-days are excluded. Ultra capacity participates in the Ultra pool; independent Non-Ultra Sunday capacity uses its own binary score `100 × (1 − (p − outcome)²)` and is excluded from the overall score. Top-pick and top-three use descending probability, with ties resolved by event order.

Small samples are preliminary. These are prospective scores of archived predictions, not a historical backtest or a guarantee of probability calibration. Shared archives may span model versions; each snapshot identifies its version and code commit. Resetting browser storage does not remove public history.

#### Maintain shared data

Do not overwrite `data/shared` with empty starter files when installing later releases after automation is active. Keep GitHub’s generated history. If a data push conflicts with another commit, the workflow fails safely without force-pushing; the next scheduled run checks out the latest branch and retries. A failure spanning the forecast window leaves that date unscored.

Run `node --test tests/*.test.js` for validation. Run `node scripts/update-shared.cjs` only when intentionally refreshing shared files; it uses the real clock and public source and does not accept a backdated production timestamp.

The browser loads event history from `SHARED_EVENTS_URL` in `src/config.js`, using HTTP revalidation and retaining an offline cache. Only the GitHub workflow contacts Wasmegg. New shared updates trigger a history refresh while the page is open when automatic loading is enabled. A manual **Refresh history** button retrieves GitHub’s copy; it does not force an upstream update. Release ZIPs omit generated `data/shared` files to preserve the repository’s existing archive.

The Record a day form and calendar editing shortcut have been removed from the public interface. Existing saved overrides are preserved for compatibility with older exports.
