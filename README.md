# UCS Monthly Box Count Agent

This tool calculates how many subscription cheese boxes TOMME needs to prepare
for the upcoming UCS (Ultimate Cheese Subscription) box month. It is designed
to be runnable from a CLI against manually exported data, so a first
production run does not require any live API access.

## Why this exists

Appstle's raw subscription status alone is not reliable enough to plan a pack:

- Many **prepaid** subscriptions remain `active` after their term has finished.
- Prepaid subscriptions are **non-recurring** — counting them by `next_order_date`
  treats them as if they were recurring, which double-books or misses boxes.
- Recurring billing happens on the 25th; new signups between the 26th and 24th
  have already paid at checkout and must not be billed again.

The agent fuses three data sources and applies term-coverage logic:

1. The Appstle subscription CSV export.
2. Successful Shopify / Appstle orders (CSV/JSON fixture today, live adapter
   slot reserved).
3. Prepaid fulfillment logic derived from purchase dates and plan length.

## Cycle rules

- Recurring billing happens on the **25th** of each month.
- A charge on the 25th of month X pays for **month X+1's** box.
- Signups between the **26th** of month X-1 and the **24th** of month X already
  paid for X+1's box at signup, so they are not billed on the 25th.

For a run date `D` and target box month `M = month-after-25th-of-D-month`:

| Bucket | Source | Rule |
| --- | --- | --- |
| Recurring billing | Shopify orders | Paid UCS orders on the 25th of M-1 |
| New-order window | Shopify orders | Paid UCS orders in `[26th of M-2, 24th of M-1]` |
| Prepaid coverage | Appstle subs + Shopify orders | Plan term covers M |
| Expected recurring (estimate only) | Appstle subs | `next_order_date == 25th of M-1` and status active, non-prepaid |

## Install

Requires Node.js 18+. No runtime dependencies.

```bash
git clone https://github.com/cancheezman/UCS_box_counter
cd UCS_box_counter
npm test
```

## Usage

```bash
# Mid-month estimate run (around the 8th/9th)
node bin/ucs-box-counter.js \
    --type estimate \
    --run-date 2026-05-09 \
    --appstle samples/appstle_subscriptions.csv \
    --orders samples/shopify_orders.csv \
    --out ./out

# Final run after the 25th billing cycle (typically the 26th)
node bin/ucs-box-counter.js \
    --type final \
    --run-date 2026-05-26 \
    --appstle samples/appstle_subscriptions.csv \
    --orders samples/shopify_orders.csv \
    --out ./out

# Or pin the target month explicitly
node bin/ucs-box-counter.js \
    --type final \
    --target-month 2026-06 \
    --appstle samples/appstle_subscriptions.csv \
    --orders samples/shopify_orders.csv
```

Outputs in `--out` (default `./out`):

- `summary_<YYYY-MM>_<type>.md` — human-readable Markdown summary.
- `summary_<YYYY-MM>_<type>.json` — machine-readable summary with warnings.
- `boxes_<YYYY-MM>_<type>.csv` — UTF-8 BOM CSV, one row per counted box.

## Required Appstle export

From the Appstle admin, export the subscription list as CSV. Required fields
(synonyms accepted — the normalizer is forgiving):

- `subscription_id`, `customer_name`, `customer_email`, `status`
- `product_id`, `product_name`, `plan_name`
- `created_date`, `next_order_date`
- `delivery_method` and shipping address fields where available
- `processed_order_count`, `revenue` (optional)

The current Appstle CSV ingest is read-only and works against the most
recent manually downloaded export. Save it somewhere stable and pass the
path with `--appstle`.

## Shopify orders

The first production run uses a manually exported CSV (Shopify Admin →
Orders → Export). Pass it with `--orders <path>`. The adapter understands
both CSV and JSON formats.

A `live` adapter slot is reserved in `src/shopify.js`. It throws by design
until real credentials and pagination are wired up so that tests never make
network calls. To plug a live integration in later:

1. Provide `auth.accessToken` to `createAdapter({ mode: 'live', auth })`.
2. Implement `fetchOrders({ since, until })` using `@shopify/admin-api-client`
   (or similar).
3. In scheduled contexts, pass `api_credentials=['external-tools']` and
   wire credentials at the harness/connector layer rather than in source.

## Schedule recommendations

- **Estimate run:** around the 8th–9th of the month. Counts recurring subs
  expected to bill on the upcoming 25th, new UCS orders already placed since
  the 26th, and prepaid subs whose term covers the target month.
- **Final run:** on the 26th, after the 25th billing run has settled.
  Counts successful paid recurring orders from the 25th, successful new UCS
  orders from the 26th–24th window, prepaid coverage, and any manual
  adjustments. This is the pack count.

## Deduplication

Duplicates across buckets are removed at the *target box month* level using
the following key order:

1. `subscription_id`
2. `shopify_customer_id` + target month
3. `customer_email` + target month
4. `customer_email` + product/plan + target month

Bucket priority for which row wins when input order is mixed:
`recurring_billing` > `new_order_window` > `prepaid_coverage` >
`expected_recurring`.

## Review flags

The agent never silently drops edge cases. Each is emitted as a warning in
`warnings[]` of the JSON summary, with a count in the Markdown report:

- `plan_length_unknown` — prepaid plan with unrecognized length string.
- `prepaid_has_next_order_date` — likely Appstle state bug.
- `active_no_future_charge_no_prepaid` — would never get billed.
- `customer_email_missing`.
- `multiple_subscriptions_same_email`.
- `order_partially_refunded`.
- `paused_but_paid_for_target_month`.
- `cancelled_after_paying_for_target`.
- `product_id_mismatch_name_looks_ucs`.
- `delivery_method_missing`.

## Known limitations

- Appstle CSV schemas vary by account/version. The normalizer accepts many
  synonyms but does not auto-discover unmapped fields; if your export uses
  an unfamiliar header, add it to `src/normalize.js`.
- The live Shopify adapter is a stub. Tests run entirely against fixtures.
- Currency totals are read but not used in any count (refunded amount IS
  used as a heuristic to flag full vs partial refunds).
- "Manual adjustments / exceptions" for the final run are not yet a first-
  class input. For now, add or remove rows in the orders fixture, or
  post-edit the output CSV.

## Tests

```bash
npm test
```

The suite covers:

- Date/cycle math for the spec's run-date examples (May 9, May 26, June 9, June 26).
- Prepaid plan parsing and coverage ranges for 2/3/4/6/12-month plans.
- Recurring-billing-order and new-order-window eligibility (including refunds,
  cancellations, and product matching).
- Deduplication across buckets by subscription_id, customer ID, and email.
- All warning codes.
- CSV column order, UTF-8 BOM, and Markdown/JSON summary language.
- End-to-end CLI run against `samples/`.
