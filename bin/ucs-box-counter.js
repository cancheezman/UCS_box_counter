#!/usr/bin/env node
'use strict';

// CLI entry point for the UCS Monthly Box Count Agent.
//
// Usage:
//   ucs-box-counter --type estimate --run-date 2026-05-09 \
//       --appstle ./appstle.csv --orders ./shopify-orders.csv \
//       --out ./out
//
//   ucs-box-counter --type final --target-month 2026-06 \
//       --appstle ./appstle.csv --orders ./shopify-orders.csv

const fs = require('fs');
const path = require('path');
const { parseObjects } = require('../src/csv');
const { normalizeAppstleSubscription } = require('../src/normalize');
const { createAdapter } = require('../src/shopify');
const { runCount } = require('../src/count');
const { buildMarkdown, buildJson, buildCsv } = require('../src/report');
const { computeCycle, computeCycleFromTarget, formatDate, addMonths } = require('../src/dates');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (a === '-v' || a === '--version') { args.version = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
      continue;
    }
    args._.push(a);
  }
  return args;
}

function usage() {
  return [
    'UCS Monthly Box Count Agent',
    '',
    'Usage:',
    '  ucs-box-counter [options]',
    '',
    'Options:',
    '  --type <estimate|final>   Report type (default: estimate).',
    '  --run-date <YYYY-MM-DD>   Run date; cycle is derived from it.',
    '  --target-month <YYYY-MM>  Target box month; overrides --run-date.',
    '  --appstle <path>          Path to the Appstle subscription CSV export.',
    '  --orders <path>           Path to a Shopify/Appstle orders CSV or JSON fixture.',
    '  --shopify-live            Ingest orders live via the `external-tool` connector',
    '                            (source_id "shopify", read-only graphql_query).',
    '                            Mutually exclusive with --orders.',
    '  --since <YYYY-MM-DD>      Start of the live ingestion date window. Defaults',
    '                            to the start of the new-order window for the target.',
    '  --until <YYYY-MM-DD>      End of the live ingestion date window. Defaults to',
    '                            the billing cycle date for the target.',
    '  --out <dir>               Output directory (default: ./out).',
    '  --quiet                   Suppress summary on stdout.',
    '  --verbose                 Also print the mask-safe Markdown summary to stdout.',
    '  --help                    Show this help.',
    '  --version                 Print version and exit.',
    '',
    'Examples:',
    '  # Offline / manual export',
    '  ucs-box-counter --type estimate --run-date 2026-05-09 \\',
    '      --appstle samples/appstle.csv --orders samples/shopify-orders.csv',
    '',
    '  # Live Shopify ingestion via external-tool',
    '  ucs-box-counter --type final --target-month 2026-06 \\',
    '      --appstle ./data/appstle.csv --shopify-live',
    '',
    'Notes:',
    '  Live mode requires the `external-tool` CLI to be present in $PATH (or set',
    '  EXTERNAL_TOOL_BIN). Authentication is performed by the connector — this',
    '  agent never sees or stores Shopify tokens. The live ingestion query is',
    '  read-only (graphql_query). In scheduled/background contexts, run with',
    '  api_credentials=["external-tools"].',
  ].join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (args.version) {
    const pkg = require('../package.json');
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  const reportType = args.type || 'estimate';
  if (!['estimate', 'final'].includes(reportType)) {
    process.stderr.write(`Error: --type must be 'estimate' or 'final' (got '${reportType}').\n`);
    return 2;
  }
  if (!args.appstle) {
    process.stderr.write('Error: --appstle <path> is required.\n');
    return 2;
  }
  if (!fs.existsSync(args.appstle)) {
    process.stderr.write(`Error: appstle file not found: ${args.appstle}\n`);
    return 2;
  }

  // Load Appstle CSV.
  const appstleText = fs.readFileSync(args.appstle, 'utf8');
  const appstleRows = parseObjects(appstleText);
  const subscriptions = appstleRows.map(normalizeAppstleSubscription);

  // Load orders. Three modes:
  //   --orders <file>     : load from local CSV/JSON
  //   --shopify-live      : ingest via the external-tool connector
  //   (neither)           : orders empty (subscriptions-only run)
  if (args.orders && args['shopify-live']) {
    process.stderr.write('Error: --orders and --shopify-live are mutually exclusive.\n');
    return 2;
  }
  let orders = [];
  if (args.orders) {
    if (!fs.existsSync(args.orders)) {
      process.stderr.write(`Error: orders file not found: ${args.orders}\n`);
      return 2;
    }
    const adapter = createAdapter({ fixturePath: args.orders });
    orders = await adapter.fetchOrders({});
  } else if (args['shopify-live']) {
    // Compute the ingestion window. We default to [new-order window start,
    // billing cycle date] — that covers both the 25th billing run and the
    // new-order window. For target month M:
    //   since = 26th of M-2
    //   until = 25th of M-1 (billing cycle date)
    // Operators can override with --since/--until.
    const cycle = args['target-month']
      ? computeCycleFromTarget(args['target-month'])
      : computeCycle(args['run-date'] || new Date());
    const since = args.since || formatDate(cycle.newOrderWindowStart);
    // Default upper bound: one day after billing cycle, to catch orders
    // processed just after midnight on the 25th.
    const defaultUntil = formatDate(addMonths(cycle.billingCycleDate, 0));
    const until = args.until || defaultUntil;
    const log = args.quiet ? null : (msg) => process.stderr.write(`${msg}\n`);
    const adapter = createAdapter({
      mode: 'live',
      log,
    });
    if (!args.quiet) {
      process.stderr.write(`shopify live: ingesting orders ${since} -> ${until}\n`);
    }
    orders = await adapter.fetchOrders({ since, until });
    if (!args.quiet) {
      process.stderr.write(`shopify live: fetched ${orders.length} line items\n`);
    }
  }

  const result = runCount({
    subscriptions,
    orders,
    runDate: args['run-date'] || null,
    targetMonth: args['target-month'] || null,
    reportType,
  });

  const outDir = path.resolve(process.cwd(), args.out || 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${result.target_box_month}_${result.report_type}`;
  const mdPath = path.join(outDir, `summary_${stamp}.md`);
  const jsonPath = path.join(outDir, `summary_${stamp}.json`);
  const csvPath = path.join(outDir, `boxes_${stamp}.csv`);
  fs.writeFileSync(mdPath, buildMarkdown(result), 'utf8');
  fs.writeFileSync(jsonPath, buildJson(result), 'utf8');
  fs.writeFileSync(csvPath, buildCsv(result), 'utf8');

  if (!args.quiet) {
    // Privacy: print only count totals and file paths to stdout. The full
    // Markdown summary is written to disk (and contains only mask-safe
    // warning messages); the customer-level CSV is the only place full PII
    // lives, and it never goes to stdout. Use --verbose to also print the
    // mask-safe Markdown body.
    const c = result.counts;
    const lines = [
      `UCS box count — ${result.report_type} for ${result.target_box_month}`,
      `  billing cycle: ${result.billing_cycle_date}`,
      `  new-order window: ${result.new_order_window_start} -> ${result.new_order_window_end}`,
      `  recurring billing: ${c.gross_by_bucket.recurring_billing} (net ${c.net_by_bucket.recurring_billing})`,
      `  new-order window: ${c.gross_by_bucket.new_order_window} (net ${c.net_by_bucket.new_order_window})`,
      `  prepaid coverage: ${c.gross_by_bucket.prepaid_coverage} (net ${c.net_by_bucket.prepaid_coverage})`,
      `  expected recurring: ${c.gross_by_bucket.expected_recurring} (net ${c.net_by_bucket.expected_recurring})`,
      `  duplicates removed: ${c.duplicates_removed}`,
      `  final box count: ${c.final_box_count}`,
      `  warnings: ${Object.keys(result.warning_counts || {}).length} code(s), ${(result.warnings || []).length} entries`,
      '',
      `Wrote: ${mdPath}`,
      `Wrote: ${jsonPath}`,
      `Wrote: ${csvPath}`,
      '',
      'Note: customer-level details are written only to the CSV/JSON above.',
      'See PRIVACY.md for handling guidance.',
      '',
    ];
    process.stdout.write(lines.join('\n'));
    if (args.verbose) {
      process.stdout.write('\n' + buildMarkdown(result) + '\n');
    }
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      // Privacy: scrub anything that looks like an email or long digit run
      // from error output before printing. Internal IDs are kept short on
      // purpose so operators can find them in the source files.
      const raw = String(err.stack || err.message || err);
      const scrubbed = raw
        .replace(/[\w.+-]+@[\w.-]+/g, '[email]')
        .replace(/\b\d{7,}\b/g, '[id]');
      process.stderr.write(`ucs-box-counter: ${scrubbed}\n`);
      process.exit(1);
    }
  );
}

module.exports = { main, parseArgs, usage };
