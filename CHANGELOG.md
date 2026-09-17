# Changelog

## v0.5 - 2026-09-17

- Fixed historical forecasts so they only use events known through the selected reference day. Later events and sync times no longer change those predictions, though corrections to older history still can.
- Moved prediction calculations into the background so the page stays responsive. An “Updating predictions…” message appears while calculations run, and the previous results stay visible until the new ones are ready. This also works when opening the app directly from a folder.
- Made the reference date clearer by labeling it as Pacific time and adding a **Current event day** button. A date you select now stays selected during automatic syncs. Today’s and Tomorrow’s panels have **Live** labels to show that they follow the current day.
- Limited **Record a day** to past and current event days. Existing future entries are kept, but forecasts ignore them until the reference date reaches them.
- Added a **Regular schedule** calendar toggle for past and future dates. These entries are labeled **Scheduled**, since they show the usual weekly pattern rather than confirmed events. The Pacific date is also shown when it differs from your local date.
- Added markers between forecast rows to show how many dates were skipped. Made the collapse arrows easier to see, fixed cards that stayed stretched after being collapsed, tidied up the rule alignment, and shortened **Confirm day** to **Confirm**.
- Added tests for historical forecasts, background calculations, and the six-day Non-Ultra Hab Sale minimum gap.

## v0.4 - 2026-09-16

- Reduced the Non-Ultra Hab Sale minimum gap from 7 days to 6 days, allowing forecasts to consider six-day returns.

- Streamlined the Forecast page with collapsible named sections, local-date manual entry, clearer **Today** status labels, and Next X Days views that skip all-zero dates while continuing forward to fill the requested range.
- Expanded the calendar with configurable confirmed/predicted overlays, Ultra/Non-Ultra filters, probability thresholds, fixed Friday–Monday events, likely future events, and clearer solid-border styling for fixed predictions.
- Improved usability and performance with lazy/batched Data rendering, simpler model documentation, official in-game event terminology throughout the UI/docs, clearer rule presentation, and removal of the redundant 5-day Ultra-gap constraint.

## v0.3 - 2026-09-11

- Stabilized Monte Carlo seeding so changing the Next X Days horizon only adds or removes dates; probabilities for dates already in view remain identical. The same prefix-stability rule now applies to the adjustable Double Capacity week horizon.
- Made the forecast reference follow the Pacific event-day rollover automatically. When the app detects or syncs a new event day, Next X Days advances immediately so today is never left in the future forecast, without requiring a page refresh.

## v0.2 - 2026-09-10

- Reworked forecast probabilities so Tuesday–Thursday Non-Ultra events and eligible Ultra cadence days each divide a guaranteed 100% event slot; Ultra scheduling now follows the observed every-other-Pacific-day cadence from May 4, 2026 forward.
- Promoted Boost Duration, Gifts, Shells, and Fueling to full Ultra / Non-Ultra event rotations across forecasts, next-date cards, status, calendar, gap history, manual entry, and data views.
- Split Double Capacity into its own Sunday-only forecast with independent Ultra / Non-Ultra modeling, a default 4-Sunday outlook, adjustable week count, Sunday overlay support, and corrected Non-Ultra next-date prediction.
- Added Today and Tomorrow event tiles, future-only Next X Days forecasting, immediate counter resets for events that hit today, fixed Friday–Monday Non-Ultra tomorrow events, and a sticky date column when forecast events scroll horizontally.
- Standardized event timing on Pacific Time, added server-clock synchronization with browser fallback, and automatically converts displayed dates for international visitors while retaining the Pacific event date.
- Improved reliability and performance with Wasmegg seed-data auditing/corrections, cached forecast calculations, optimized next-hit simulations, and responsive handling of the expanded event set.

## v0.1 - 2026-09-10

Initial public-ready release of Egg Event Lab.

- Configurable event forecasts and most-likely-next-date cards
- Housing, shipping, drone, and double-capacity Ultra / Non-Ultra rotations
- Wasmegg synchronization from January 1, 2024 forward
- Rolling recency weighting and conditional gap-hazard modeling
- Non-Ultra Tue–Thu competition/blocker modeling
- Egg Day (July 14) exclusion from model training
- Calendar, gap history, rules, local overrides, and JSON import/export
