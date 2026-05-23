'use strict';

// Reporting: build a Markdown + JSON summary and a customer-level CSV.

const { stringifyObjects } = require('./csv');

const CSV_COLUMNS = [
  'target_box_month',
  'report_type',
  'customer_name',
  'customer_email',
  'subscription_id',
  'shopify_order_id',
  'product_id',
  'product_name',
  'plan_name',
  'subscription_type',
  'source_bucket',
  'purchase_date',
  'billing_cycle_date',
  'prepaid_first_box_month',
  'prepaid_last_box_month',
  'delivery_method',
  'shipping_name',
  'shipping_address_1',
  'shipping_address_2',
  'city',
  'province',
  'postal_code',
  'phone',
  'status',
  'notes',
  'needs_review',
  'gray_zone',
  'gray_zone_status',
  'tentative_box_month',
  'default_box_month',
  'override_action',
  'override_target_month',
  'override_reason',
];

const GRAY_ZONE_CSV_COLUMNS = CSV_COLUMNS;

function estimateLanguage() {
  return 'This is an estimate for cheese ordering. Final count will be confirmed after the 25th billing cycle.';
}

function finalLanguage() {
  return 'This is the final pack count for next month\'s UCS boxes.';
}

function buildMarkdown(report) {
  const lang = report.report_type === 'final' ? finalLanguage() : estimateLanguage();
  const gross = report.counts.gross_by_bucket;
  const net = report.counts.net_by_bucket;
  const warningLines = Object.entries(report.warning_counts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `- \`${code}\`: ${n}`)
    .join('\n') || '- (none)';
  const grayZoneCounts = report.counts || {};
  const grayZoneIncluded = net.gray_zone_late_order_included || 0;
  const lines = [
    `# UCS Box Count — ${report.report_type === 'final' ? 'Final' : 'Estimate'}`,
    '',
    `**Target box month:** ${report.target_box_month}  `,
    `**Report type:** ${report.report_type}  `,
    `**Run date:** ${report.run_date || '(target-month override)'}  `,
    `**Billing cycle date:** ${report.billing_cycle_date}  `,
    `**New-order window:** ${report.new_order_window_start} → ${report.new_order_window_end}  `,
    `**Gray-zone window:** ${report.gray_zone_window_start || '?'} → ${report.gray_zone_window_end || '?'} (${report.gray_zone_schedule_source || 'unknown'})`,
    '',
    `> ${lang}`,
    '',
    '## Counts',
    '',
    '| Bucket | Gross | After dedupe |',
    '| --- | ---: | ---: |',
    `| Recurring billing (25th) | ${gross.recurring_billing} | ${net.recurring_billing} |`,
    `| New-order window (26th-24th) | ${gross.new_order_window} | ${net.new_order_window} |`,
    `| Prepaid coverage | ${gross.prepaid_coverage} | ${net.prepaid_coverage} |`,
    `| Expected recurring (estimate) | ${gross.expected_recurring} | ${net.expected_recurring} |`,
    `| Gray-zone (manually included) | ${grayZoneIncluded} | ${grayZoneIncluded} |`,
    '',
    `**Duplicates removed:** ${report.counts.duplicates_removed}  `,
    `**Final box count:** **${report.counts.final_box_count}**`,
    '',
    '## Gray-zone review',
    '',
    `- Gray-zone candidates surfaced (default deferred to next month): ${grayZoneCounts.gray_zone_candidates || 0}`,
    `- Records excluded from this month via override: ${grayZoneCounts.gray_zone_excluded || 0}`,
    `- Records deferred to another month (default or override): ${grayZoneCounts.gray_zone_deferred || 0}`,
    `- Gray-zone records counted in this month: ${grayZoneIncluded}`,
    '',
    '## Review flags',
    '',
    warningLines,
    '',
  ];
  return lines.join('\n');
}

function buildJson(report) {
  return JSON.stringify({
    report_type: report.report_type,
    target_box_month: report.target_box_month,
    run_date: report.run_date,
    billing_cycle_date: report.billing_cycle_date,
    new_order_window_start: report.new_order_window_start,
    new_order_window_end: report.new_order_window_end,
    gray_zone_window_start: report.gray_zone_window_start,
    gray_zone_window_end: report.gray_zone_window_end,
    gray_zone_schedule_source: report.gray_zone_schedule_source,
    language: report.report_type === 'final' ? finalLanguage() : estimateLanguage(),
    counts: report.counts,
    warning_counts: report.warning_counts,
    warnings: report.warnings,
    gray_zone_candidates: report.gray_zone_candidates || [],
    gray_zone_excluded: report.gray_zone_excluded || [],
    gray_zone_deferred: report.gray_zone_deferred || [],
  }, null, 2);
}

function buildCsvRow(entry, report, extras = {}) {
  return {
    target_box_month: report.target_box_month,
    report_type: report.report_type,
    customer_name: entry.customer_name || '',
    customer_email: entry.customer_email || '',
    subscription_id: entry.subscription_id || '',
    shopify_order_id: entry.shopify_order_id || '',
    product_id: entry.product_id || '',
    product_name: entry.product_name || '',
    plan_name: entry.plan_name || '',
    subscription_type: entry.subscription_type || '',
    source_bucket: entry.source_bucket || '',
    purchase_date: entry.purchase_date || '',
    billing_cycle_date: entry.billing_cycle_date || report.billing_cycle_date,
    prepaid_first_box_month: entry.prepaid_first_box_month || '',
    prepaid_last_box_month: entry.prepaid_last_box_month || '',
    delivery_method: entry.delivery_method || '',
    shipping_name: entry.shipping_name || '',
    shipping_address_1: entry.shipping_address_1 || '',
    shipping_address_2: entry.shipping_address_2 || '',
    city: entry.city || '',
    province: entry.province || '',
    postal_code: entry.postal_code || '',
    phone: entry.phone || '',
    status: entry.status || '',
    notes: entry.notes || '',
    needs_review: entry.needs_review || extras.needs_review || '',
    gray_zone: entry.gray_zone ? 'yes' : '',
    gray_zone_status: extras.gray_zone_status || '',
    tentative_box_month: entry.tentative_box_month || '',
    default_box_month: entry.default_box_month || '',
    override_action: entry.override_action || '',
    override_target_month: entry.override_target_month || '',
    override_reason: entry.override_reason || '',
  };
}

function buildCsv(report) {
  const rows = report.entries.map((e) =>
    buildCsvRow(e, report, {
      gray_zone_status: e.gray_zone ? 'counted_for_target' : '',
    })
  );
  // UTF-8 BOM + CRLF line endings for Excel friendliness.
  return stringifyObjects(rows, CSV_COLUMNS, { bom: true, eol: '\r\n' });
}

/**
 * Build a separate CSV for gray-zone review records. Includes counted
 * gray-zone entries plus candidates / excluded / deferred records so
 * the operator can decide case by case.
 */
function buildGrayZoneCsv(report) {
  const rows = [];
  for (const e of report.entries || []) {
    if (!e.gray_zone) continue;
    rows.push(buildCsvRow(e, report, { gray_zone_status: 'counted_for_target', needs_review: 'gray_zone' }));
  }
  for (const e of report.gray_zone_candidates || []) {
    rows.push(buildCsvRow(e, report, { gray_zone_status: 'candidate_deferred', needs_review: 'gray_zone' }));
  }
  for (const e of report.gray_zone_excluded || []) {
    rows.push(buildCsvRow(e, report, { gray_zone_status: 'override_excluded', needs_review: 'gray_zone' }));
  }
  for (const e of report.gray_zone_deferred || []) {
    rows.push(buildCsvRow(e, report, { gray_zone_status: 'deferred', needs_review: 'gray_zone' }));
  }
  return stringifyObjects(rows, GRAY_ZONE_CSV_COLUMNS, { bom: true, eol: '\r\n' });
}

module.exports = {
  CSV_COLUMNS,
  GRAY_ZONE_CSV_COLUMNS,
  buildMarkdown,
  buildJson,
  buildCsv,
  buildGrayZoneCsv,
  estimateLanguage,
  finalLanguage,
};
