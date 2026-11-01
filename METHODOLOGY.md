# Process-mining methodology

## Input and ordering

An event requires a case ID, activity name, and ISO-8601 timestamp. Timestamps without an offset are interpreted as UTC; offset timestamps are normalized to UTC. The analysis groups by case and orders by normalized timestamp, then event ID for deterministic tie-breaking.

An event identity is the SHA-256 digest of case ID, activity, normalized event time, and resource. Re-imports of the same identity are rejected as duplicates. Because this is a local demonstration, source row data is not retained beyond the normalized event and import summary.

## Process discovery

- **Variant:** exact ordered list of activity names observed for a case. Incomplete cases are retained as observed; no missing terminal event is inferred.
- **Activity event frequency:** number of stored events for an activity.
- **Activity case coverage:** number of distinct case IDs containing that activity. This is not event frequency.
- **Directly-follows edge:** each adjacent pair in a timestamp-ordered case trace. Edge `count` is the number of such event pairs; `case_count` is the number of distinct cases containing the pair.
- **Transition share:** edge event-pair count divided by all adjacent event pairs in the selected dataset.
- **Elapsed time:** nonnegative timestamp difference between adjacent events; summary includes arithmetic mean and median.

A directly-follows graph is descriptive evidence of observed event order. It does not establish causality, concurrency, or a normative process model.

## Performance and quality

- **Case cycle time:** last observed timestamp minus first observed timestamp for cases containing at least two events. One-event cases are active/incomplete and excluded from cycle-time summaries.
- **P90:** linear interpolation at position `(n - 1) × 0.9` in the sorted case cycle-time values.
- **SLA breach:** a case with observed cycle time strictly greater than 72 elapsed hours. This is a demonstration threshold in `server.py`, not a business-configured service commitment.
- **Rework rate:** share of cases whose sequence contains at least one repeated activity name.
- **Import validity score:** accepted imported rows divided by submitted rows across recorded imports. Synthetic seed records are not included. Validation catches only the implemented required-field, timestamp, duplicate, and length rules; this is not a comprehensive data-quality score.
- **Bottleneck candidate:** directly-follows edge with a median elapsed time of at least eight hours and at least `max(5, ceil(4% of selected cases))` distinct cases. This threshold prioritizes investigation, not proof of queue time or root cause.

The 30-, 90-, and 365-day window filters event timestamps relative to the server's current UTC time. Prior-period comparisons are not calculated.

## Automation opportunity and financial estimate

Opportunity cards use repeated activity sequences and the bottleneck rule as observed signals. Descriptions explicitly ask for process-owner validation. The app does not infer a confirmed cause, claim an activity is automatable, or attribute realized savings.

For editable scenario assumptions:

```text
annual addressable labor cost =
  annual volume × manual minutes ÷ 60 × loaded hourly cost

annual gross savings =
  annual addressable labor cost × eligible share
  × expected time reduction × realization factor

annual net benefit = annual gross savings − annual recurring cost

ramp factor = clamp((12 − ramp months ÷ 2) ÷ 12, 0, 1)

first-year net impact =
  annual gross savings × ramp factor
  − annual recurring cost − implementation cost

three-year gross savings =
  annual gross savings × (3 − ramp months ÷ 24)

three-year net benefit =
  three-year gross savings − implementation cost
  − 3 × annual recurring cost

three-year ROI =
  three-year net benefit ÷ (implementation cost + 3 × annual recurring cost) × 100

payback months =
  implementation cost ÷ (annual net benefit ÷ 12) + ramp months ÷ 2
```

Payback is shown only when annual net benefit is positive. The cash-flow model is undiscounted and approximates ramp-up using a linear half-ramp-year adjustment. It does not model tax, working capital, overlap/double-counting across opportunities, realization by cohort, or risk-adjusted outcomes. Outputs are estimates until validated against financial and operational records.

## Synthetic seed data

On first start, 180 invoice cases are generated from a fixed UTC start date and a deterministic combination of five sequence patterns: standard approval, repeated approval, correction/resubmission loop, incomplete trace, and auto-approved path. Timestamps and resources derive from each case number. The seed is inserted into the same SQLite `events` table used by imports. It is intentionally synthetic and is not customer or benchmark data.

