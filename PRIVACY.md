# Privacy Notice — UCS Monthly Box Count Agent

This tool runs on a local machine, processes customer data exported from
TOMME's existing Appstle and Shopify accounts, and produces a pack list for
the next UCS box month. It does not introduce a new system of record. This
document describes what data the tool touches, why, where it goes, and the
operational safeguards expected of anyone running it.

The framing below is intended to be appropriate for Canadian / PIPEDA-style
safeguards (accountability, identifying purposes, consent already obtained
through the underlying TOMME ↔ customer subscription, limiting collection
and use, safeguards, individual access via TOMME's existing customer
service). TOMME — not this tool — is the accountable organization for the
underlying customer relationship; the tool is one piece of internal
fulfillment infrastructure.

## 1. PII categories processed

Data is read **only from local files the operator provides** (Appstle CSV
export, Shopify orders CSV/JSON). Per row, the tool reads:

| Category | Examples | Used for |
| --- | --- | --- |
| Identifiers | `subscription_id`, `order_id`, `shopify_customer_id` | dedupe, audit |
| Contact info | `customer_email`, `phone` | dedupe, packing slip, exception triage |
| Name | `customer_name`, `shipping_name` | packing slip |
| Address | `shipping_address_1/2`, `city`, `province`, `postal_code` | shipping |
| Subscription / commerce state | `status`, `plan_name`, `product_id/name`, `created_date`, `next_order_date`, `cancellation_date`, `processed_order_count`, `financial_status`, `fulfillment_status`, refund/total | eligibility, counting, review flags |

Fields outside this list (Appstle/Shopify exports are wide) are
**ignored at normalize time** — the tool does not retain the raw row on the
in-memory record. See `src/normalize.js`.

## 2. Purpose

The exclusive purpose is to compute how many UCS subscription cheese boxes
to pack for an upcoming box month, and to produce the customer-level pack
list used in fulfillment. The same information already flows through
TOMME's Appstle and Shopify accounts for the same purpose; this tool
re-combines it to handle prepaid logic correctly.

## 3. Data sources

- **Appstle subscription CSV** — manually exported by an operator from the
  Appstle admin.
- **Shopify orders** — for the first production run, manually exported from
  Shopify Admin → Orders → Export. The live Shopify adapter slot exists
  but is disabled until credentials are wired in.

Both inputs are local files. **No cloud upload, no third-party API call,
no model / AI call is ever made with customer data.** See "Local-first
processing" below.

## 4. Outputs

For each run the tool writes three files into the operator's chosen
`--out` directory (default `./out`):

- `summary_<YYYY-MM>_<type>.md` — Markdown summary (counts, dates, review
  flags). All warning messages are **masked** (see §6) so this file is
  safe to share inside the ops team.
- `summary_<YYYY-MM>_<type>.json` — same data plus structured warning
  context. The `warnings[].context` blocks include real emails / IDs for
  reconciliation and **must be treated as sensitive**.
- `boxes_<YYYY-MM>_<type>.csv` — UTF-8 BOM CSV, one row per counted box.
  Contains the names, emails, phone numbers, and shipping addresses
  needed for fulfillment. **This is the only file that contains full PII
  by design.** It is intended for direct hand-off to fulfillment.

The repo's `.gitignore` excludes all output files; they should never be
committed.

## 5. Local-first processing

- No PII is sent to any AI/model API. The tool has no LLM integration.
- No telemetry, analytics, or error-reporting endpoints.
- The only intended network path is the explicit Shopify Admin API
  adapter, and only when an operator chooses to enable it. Until then,
  `src/shopify.js`'s live adapter throws by design.
- The Shopify live adapter is **read-only in intent**: it requires the
  `read_orders` and `read_products` scopes and must never call write APIs.
- Auth tokens (when configured) live in a closure inside the adapter
  factory. They are not attached to the adapter object, never logged,
  never serialized, and any error surfaced from the live path is run
  through a token-scrubber. Tests pin this behavior.

## 6. Safe logging

- Default CLI stdout is a numeric summary plus output file paths. No
  customer rows, no emails, no addresses, no phone numbers.
- `--verbose` adds the Markdown summary body. That body contains only
  **mask-safe** warning messages: `maskEmail("alice@example.com")` →
  `a***@e***.com`, `maskId("APP-1001")` → `AP***01`,
  `maskPhone("+1 555-010-1234")` → `***-***-1234`. See `src/privacy.js`.
- Unhandled CLI errors run through a regex scrub that replaces
  email-shaped substrings with `[email]` and long digit runs with `[id]`.
- The structured `warnings[].context` blocks **do** retain real values for
  reconciliation; treat the JSON summary file with the same care as the
  CSV.

## 7. Operational safeguards (operator responsibilities)

- Run the tool on a managed workstation, not a shared / public computer.
- Keep real exports under `data/` (or any directory outside the repo
  working tree). `.gitignore` blocks accidental commits, but the repo
  should not be the storage of record.
- Do not paste raw CSV contents into chat, screenshots, or ticketing
  systems. If you need to share a row's context, share the masked
  warning message or the dedupe key, not the full row.
- Restrict who can read the `--out` directory.
- After the pack month is closed, **delete or securely archive** the
  dated outputs. The pack list is operational, not a permanent record;
  retaining it after the season closes only increases breach exposure
  for no business benefit.
- Avoid sharing CSV outputs over broad channels (org-wide Slack channels,
  open Drive folders, personal email). Use a scoped folder or hand-deliver.
- Never commit `.env` files or hardcoded Shopify tokens. Use the
  `api_credentials=['external-tools']` pattern for scheduled contexts so
  credentials are injected by the connector layer.

## 8. Retention

The tool itself stores nothing across runs. Files in `--out` persist for
as long as the operator chooses to keep them. Recommended retention:

- Keep the dated outputs only as long as the pack month is operationally
  active (typically the box month itself plus a short reconciliation
  window).
- After that window, delete the customer-level CSV and JSON. Keep the
  Markdown summary if you want a historical count record — it does not
  contain raw PII.

## 9. Individual access / corrections

This tool is downstream of Appstle and Shopify. Customer access,
correction, or deletion requests are handled through TOMME's standard
customer-service path against the upstream systems of record. Re-running
the tool with a fresh export will reflect any upstream changes.

## 10. What this tool does NOT do

- It does not transmit customer data over the network (until and unless
  the live Shopify adapter is explicitly enabled by the operator).
- It does not store data across runs. Each run is independent.
- It does not modify Appstle or Shopify records.
- It does not call any AI / LLM / model API.
- It does not collect telemetry or analytics.
- It does not write outside the chosen `--out` directory.

## 11. Reporting a privacy issue

If you spot a privacy regression — for example, a code path that prints
a full email to stdout, an output file that escapes `--out`, or a new
field being normalized without justification — open an issue on this
repo and tag it `privacy`. Privacy is treated as an acceptance criterion
for PRs, not a polish item.
