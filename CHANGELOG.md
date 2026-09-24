# Changelog

## v0.6 — 2026-09-23

- Reduced the scoring wait to one hour after release, with one hour of unchanged source data.

- Applied gap smoothing to Ultra events too, so an unseen gap no longer gives an eligible event a 0% chance.

- Added pre-release percentages to today’s events. Reconstructed forecasts are labeled when no saved prediction is available.
- Added shared accuracy scores for the last 30, 90, and 180 days, with separate Ultra, Non-Ultra, and Double Capacity results.
- GitHub now updates event history hourly and saves forecasts automatically, so scores no longer depend on someone opening the app. Late or incomplete data stays unscored until ready; incomplete forecasts are excluded.
- Removed Record a day and its calendar shortcut. Daily event status now fills the available width.

## v0.5 — 2026-09-17

- Replaced the hard 16-day Non-Ultra limit with estimates based on each event’s history. Overdue events and previously unseen gaps are no longer treated as impossible.
- Fixed historical forecasts to exclude events after the selected date.
- Moved calculations into the background and added an updating indicator so the page stays usable.
- Clarified Pacific reference dates, added a Current event day button, and kept selected dates from moving during syncs. Today and Tomorrow now have Live labels.
- Added scheduled calendar entries, skipped-date markers, and a Double Capacity tile when tomorrow has a chance of one.
- Improved collapsible sections and alignment, and blocked future manual entries.

## v0.4 — 2026-09-16

- Lowered the Non-Ultra Hab Sale minimum gap to six days and removed the redundant Ultra five-day restriction.
- Added collapsible forecast sections and calendar filters. Next X Days now skips dates with no chance of a selected event.
- Improved data loading, event names, date labels, and model explanations.

## v0.3 — 2026-09-11

- Extending the forecast range no longer changes probabilities for dates already shown.
- Forecast dates now advance automatically when the Pacific event day changes.

## v0.2 — 2026-09-10

- Added Boost Time, Gifts, Shells, and Fueling as full event rotations.
- Updated daily probabilities to account for competing events and the every-other-day Ultra schedule.
- Gave Double Capacity its own Sunday forecast and adjustable outlook.
- Added Today and Tomorrow tiles, live counter resets, and fixed weekly events.
- Added Pacific server timing, local date conversion, and faster forecast calculations.

## v0.1 — 2026-09-10

- Initial release with event forecasts, likely next dates, a calendar, and gap history.
- Added Wasmegg history from January 2024, recent-history weighting, and Egg Day exclusions.
- Included model settings, manual overrides, and JSON import/export.
