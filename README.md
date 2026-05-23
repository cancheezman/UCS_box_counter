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

Two ingestion modes for Shopify orders:

- **File mode** (`--orders <path>`): read a manually exported Shopify CSV/JSON.
  Used for offline runs, tests, and one-off reproducibility.
- **Live mode** (`--shopify-live`): ingest orders via the host's
  `external-tool` connector (`source_id: shopify`, `tool_name: graphql_query`).
  Read-only. The agent never sees or stores Shopify access tokens — the
  connector layer handles authentication.

```bash
# Mid-month estimate, file mode
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

# Live mode (requires the `external-tool` CLI on PATH or EXTERNAL_TOOL_BIN)
node bin/ucs-box-counter.js \
    --type final \
    --target-month 2026-06 \
    --appstle ./data/appstle.csv \
    --shopify-live
```

### Live Shopify ingestion

When `--shopify-live` is set, the agent:

1. Computes the ingestion date window from the cycle (default
   `[26th of M-2, 25th of M-1]`). Override with `--since` / `--until`.
2. Calls `external-tool call '{...}'` for `source_id: "shopify"`,
   `tool_name: "graphql_query"`, with a single read-only GraphQL document
   (see `src/shopify.js` → `ORDERS_QUERY`).
3. Paginates with `pageInfo.hasNextPage` / `endCursor`, page size capped
   at 50.
4. Normalizes GraphQL `orders.nodes[]` (with one row per line item) and
   feeds them into the same `runCount` pipeline as file mode.
5. Recovers the Appstle subscription identifier from each line item's
   `customAttributes`, matching the known synonyms (`subscription_id`,
   `Subscription ID`, `appstle_subscription_id`, `_appstle_subscription_id`,
   etc.). When present, this lets the dedupe layer collapse a live-mode
   order against the Appstle subscription export by the strongest key
   (`sub:<id>`). When absent, dedupe falls back to
   `email + product/plan + month`; see [Deduplication](#deduplication).
6. If Shopify still has more results when the page budget is exhausted,
   the adapter throws a clear error rather than returning partial data.
   Narrow `--since`/`--until` (or raise `maxPages` in code) to recover.

Scopes required of the connector for the query to succeed (least
privilege — all read-only):

- `read_orders`
- `read_marketplace_orders`
- `read_quick_sale`
- `read_customers`
- `read_products`

The agent has no write codepath. The GraphQL document is hand-written and
contains only `query` operations.

### Scheduled / background runs

For unattended use, invoke the agent through a shell that has the
`external-tool` connector available. The Anthropic-style harness pattern
is to pass `api_credentials=["external-tools"]` when scheduling the bash
invocation; the connector then resolves Shopify auth at the harness layer
and this repo never sees a token.

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

File mode reads a manually exported CSV (Shopify Admin → Orders → Export);
pass it with `--orders <path>`. The adapter understands both CSV and JSON.

Live mode reads via the `external-tool` connector — see
[Live Shopify ingestion](#live-shopify-ingestion) above. The live adapter
is read-only by design, holds no credentials, and surfaces only mask-safe
error messages.

## Schedule recommendations

- **Estimate run:** around the 8th–9th of the month. Counts recurring subs
  expected to bill on the upcoming 25th, new UCS orders already placed since
  the 26th, and prepaid subs whose term covers the target month.
- **Final run:** on the 26th, after the 25th billing run has settled.
  Counts successful paid recurring orders from the 25th, successful new UCS
  orders from the 26th–24th window, prepaid coverage, and any manual
  adjustments. This is the pack count.

## Deduplication

Duplicates across buckets are removed at the *target box month* level. For
each entry the dedupe layer emits a layered key set; the most specific key
available is used, with looser keys only as fallbacks:

1. `sub:<subscription_id>` — strongest. If present, always wins.
2. `cust:<shopify_customer_id>|<month>` — when no subscription_id.
3. `email-plan:<email>|<product>|<plan>|<month>` — when an email is known
   AND there is any plan or product info on the entry. This is the normal
   case for both file-mode and live-mode order rows.
4. `email:<email>|<month>` — last-resort fallback, only emitted when the
   entry has no plan/product information at all.

The bare-email key is NOT emitted alongside the email-plan key. This
prevents two distinct UCS subscriptions sharing an email (e.g. a Monthly
and a 12-month prepaid on the same household account) from silently
collapsing to one box.

Bucket priority for which row wins when input order is mixed:
`recurring_billing` > `new_order_window` > `prepaid_coverage` >
`expected_recurring`.

## Gray-zone late orders

The first box month for a new UCS purchase is **not** the calendar month
of the order. Instead it is derived from the billing cycle and the UCS
pickup/delivery schedule (see `src/schedule.js`):

- For an order placed in `[26th of M-1, 24th of M]`, the first box month
  is `M+1`. This is the "standard" 26th-24th rule.
- For an order placed in `[25th of M-1, first pickup of M]` (the **gray
  zone** for box month `M`), the pack may already be committed. These
  orders are flagged `gray_zone_late_order` and, by default, attributed
  to box month `M+1` instead of `M`.

Example: a subscription purchased on **2026-08-28** defaults to the
**October 2026** box, not September 2026. September's first pickup is
2026-09-03 (per the TOMME UCS 2026 schedule), so the gray-zone window
for September is `[2026-08-25, 2026-09-03]`.

### Manual overrides

Pass a CSV via `--overrides <path>` to override the default attribution
for specific records. Columns:

| column | description |
| --- | --- |
| `customer_email` | one of the identifier columns (matched together with `target_box_month`) |
| `subscription_id` | strongest match key |
| `shopify_order_id` | second-strongest match key |
| `target_box_month` | `YYYY-MM`; the month this row addresses |
| `override_action` | `include` or `exclude` |
| `reason` | free-text audit trail (surfaced in the gray-zone CSV) |

Match priority is `subscription_id` -> `shopify_order_id` -> `customer_email + target_box_month`.

Each run writes a per-month review CSV at
`out/gray_zone_<YYYY-MM>_<type>.csv` listing every gray-zone candidate
(included, excluded, deferred, or surfaced) so TOMME can decide each
case by hand. A sample overrides CSV lives at
`samples/ucs_manual_overrides.csv`.

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
- `gray_zone_late_order` — order placed in the gray-zone window for the
  upcoming box month. See "Gray-zone late orders" above.

## Known limitations

- Appstle CSV schemas vary by account/version. The normalizer accepts many
  synonyms but does not auto-discover unmapped fields; if your export uses
  an unfamiliar header, add it to `src/normalize.js`.
- Live mode requires the `external-tool` CLI in the host environment.
  In environments where it is not available, run with `--orders <file>`
  against a manual export.
- Live mode recovers the Appstle subscription identifier from
  `lineItem.customAttributes` only. If your Appstle installation does
  not stamp the subscription ID onto line items under one of the
  recognized keys (see `SUBSCRIPTION_ID_ATTRIBUTE_KEYS` in
  `src/shopify.js`), live-mode rows arrive with `subscription_id = ''`
  and dedupe falls back to the email + product/plan + month key. The
  dedupe redesign in `src/dedupe.js` keeps that fallback safe (no
  silent collapsing of distinct plans on a shared email), but the
  strongest dedupe is still by subscription_id — add your key to the
  set if a real run shows orphan rows.
- Currency totals are read but not used in any count (refunded amount IS
  used as a heuristic to flag full vs partial refunds).
- "Manual adjustments / exceptions" for the final run are not yet a first-
  class input. For now, add or remove rows in the orders fixture, or
  post-edit the output CSV.

## Privacy

This tool processes customer PII (names, emails, phone numbers, shipping
addresses, subscription/order IDs). It is designed for **local-first**
processing — no cloud, no AI, no telemetry — and treats privacy as an
acceptance criterion.

Short version:

- **Read** locally exported Appstle CSVs. No network access by default.
  Shopify orders may be loaded either from a manual CSV/JSON export
  (`--orders`) or via the `external-tool` connector (`--shopify-live`,
  opt-in). The live path is read-only (read-only GraphQL document; all
  required scopes are `read_*`); authentication is handled by the
  connector layer outside this repo, so the agent never sees or stores
  Shopify access tokens.
- **Process** in memory. Only fields needed for counting, dedupe,
  delivery, and audit are normalized; raw rows are dropped.
- **Write** three files into your chosen `--out` directory: a Markdown
  summary (mask-safe), a JSON summary (mask-safe `message`, sensitive
  `context`), and a customer-level CSV (full PII by design — that is
  the operational pack list).
- **Log** safely. Default CLI stdout shows totals and file paths only —
  no full emails, addresses, or phones. Warning messages mask emails,
  IDs, and phones; structured context fields keep real values for
  reconciliation.

`.gitignore` blocks output files, real input files, `.env` files, and
credential files. Sample fixtures under `samples/` are **synthetic only**
(see `samples/README.md`).

Full details — PII categories, purpose, retention guidance, operator
responsibilities, PIPEDA-style framing, what the tool does **not** do —
are in [PRIVACY.md](./PRIVACY.md). Read it before running against real
exports.

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
- Privacy: mask utilities (`maskEmail`, `maskPhone`, `maskId`,
  `maskAddress`, `maskName`, `redactRecord`); warning messages never embed
  full emails or full IDs; CLI default stdout does not leak emails,
  addresses, or phones from the input fixtures.
- Live Shopify adapter (via injected fake connector): pagination using
  `pageInfo.hasNextPage` / `endCursor`, GID → numeric ID extraction,
  GraphQL line-item → row normalization (one row per line item, custom
  attribute values never echoed, refund-quantity heuristic at line level
  only), subscription_id recovery from line-item customAttributes,
  pagination cap hard-fails when Shopify still has more results (no
  silent truncation), connector error scrubbing for tokens / emails /
  long IDs, clean errors on empty responses. The live tests use the
  dependency-injection seam in `src/connector.js` so they never spawn
  `external-tool` and never make network calls.
- Live ingestion window defaults: `defaultLiveIngestionWindow` returns
  `until = billing_cycle_date + 1 day` so Shopify's
  `created_at:<=YYYY-MM-DD` filter actually covers the 25th billing day.
