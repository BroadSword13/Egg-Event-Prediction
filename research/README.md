# Background model comparison — October 26, 2026

This add-on starts an observational comparison. It does not release v0.7 or change the site's predictions, settings, or displayed scores.

## Install

1. Fetch/pull the latest main branch in GitHub Desktop first, so the latest automated history commits are present.
2. Copy the contents of this patch into the existing repository, preserving the folders. Replace the included workflow and changelog when prompted. Do not delete any existing files or replace the .git folder.
3. Commit and push the patch. In GitHub Actions, run **Update shared predictions** once to check the new step.
4. Look for **Archive background model comparison**. Outside the pre-release window, it will say it is waiting for the first snapshot. This is expected.

The existing hourly workflow will save both forecasts during the last six hours before release, excluding the final 15 minutes. Nothing needs to stay open. A manual daytime run does not manufacture an earlier forecast.

After the first eligible snapshot, `data/shared/shadow.json` records the first forecast date, a review date 28 days later, both frozen forecasts, and paired scores. Review after four weeks, extending the collection period if runs or settled outcomes are missing. No candidate is automatically promoted. If the first snapshot is October 27, the review date is November 24.

This is a background comparison, not confidential storage: files in a public repository are publicly readable. They are not displayed by the website.

## Candidate and baseline

The candidate blends each eligible event's gap weight 50/50 with its frequency in the previous 180 days (one pseudo-observation per eligible type). Blending is done separately within each tier before enforcing cross-tier conflicts. Both models obey the same minimum gaps, weekdays, Ultra cadence, and mutual exclusions. Frequency weighting applies to both tiers.

The baseline is the existing v0.6 one-day model evaluated analytically, without Monte Carlo noise. The candidate uses the same calculation after blending weights. Non-Ultra capacity's optional probability is also calculated, but capacity is not part of the selection score or the paired main-event score. Both forecasts include its probability for auditing.

October 17 is removed from both study models' training, cadence history, and scoring. Raw history is retained unchanged. Both models therefore preserve the expected October 18 Ultra slot. This study does not rewrite old official forecasts or modify the production model; the corresponding public exclusion remains a v0.7 change.

Implementation hashes freeze the code and settings used in the study. If the model/configuration changes, the study refuses to mix revisions; archive the old study and explicitly create a new study ID and output file. A failed study step does not prevent the official history update from being committed.

## Backtest results

Each target date sees only earlier events. Historical reconstructions use today's corrected history and the current model; they are not forecasts actually saved at the time. Source publication delays cannot be reconstructed by this backtest.

Seven fixed choices were compared: baseline, frequency blending in either/both tiers, neighboring-gap smoothing in either tier, and recent-only Ultra gaps. The candidate with the best overall development score was selected, then passed a fixed validation gate: better overall validation score, with neither tier losing more than one point. No parameters were adjusted after that gate.

| Period | Outcomes | Baseline score | Candidate score | Baseline first-choice hits | Candidate first-choice hits |
|---|---:|---:|---:|---:|---:|
| Development: May 5–July 31 | 82 | 53.6 | 59.8 | 20 | 24 |
| Held-out validation: August 1–September 23 | 50 | 62.2 | 63.3 | 20 | 22 |
| Recent diagnostic: September 24–October 26 | 30 | 59.7 | 61.7 | 8 | 10 |

The recent period was already examined during prior discussion, so it is not an untouched confirmation set. July 14 and October 17 are excluded. Only variable Non-Ultra slots and relevant Ultra outcomes enter the score; predictable fixed events and correctly forecast Ultra off-days do not inflate it.

The score is 100 × (1 − half the multiclass Brier loss), matching the app's main-event score. It is not percent correct. Validation improved by 1.16 points, with a descriptive paired-date bootstrap 95% interval of −1.26 to +3.83. That interval includes no improvement: this is a candidate for prospective testing, not a proven replacement. Validation Ultra score fell slightly, from 63.55 to 63.05, while Non-Ultra improved from 60.53 to 63.64. Recent top-three hits fell from 24/30 to 22/30 even though probability score and first-choice hits improved.

Using only recent Ultra gaps did not improve held-out results. Neighboring-gap smoothing remains a possible later experiment; it was not selected by the development criterion. Full numbers, exclusions, source hash, and uncertainty estimates are in `research/backtest-results.json`.

## Commands

Run from the repository root with Node 22:

```
node scripts/research/backtest.cjs data/shared/events.json
node --test tests/research.test.cjs
```

The historical backtest has fixed evaluation dates and writes only `research/backtest-results.json`. It never populates the live shadow archive. The updater is run by the existing workflow after the official updater:

```
node scripts/research/update-shadow.cjs
```

Each new shadow snapshot retains its raw inputs in `data/shared/shadow-inputs/DATE.json.gz`. Eligible snapshots are frozen; incomplete snapshots can improve only before release. Late/corrected actual results may regrade both scores, but cannot rewrite the saved probabilities. Both sides are scored on the same settled dates and tiers.

Tests cover future-data isolation, October 17 exclusion, probability totals and restrictions, agreement with the production sampler, pre-release cutoffs, immutability, missed-run behavior, and outcome corrections.
