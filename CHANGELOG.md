# Changelog

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
