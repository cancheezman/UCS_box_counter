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
];

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
  const lines = [
    `# UCS Box Count — ${report.report_type === 'final' ? 'Final' : 'Estimate'}`,
    '',
    `**Target box month:** ${report.target_box_month}  `,
    `**Report type:** ${report.report_type}  `,
    `**Run date:** ${report.run_date || '(target-month override)'}  `,
    `**Billing cycle date:** ${report.billing_cycle_date}  `,
    `**New-order window:** ${report.new_order_window_start} → ${report.new_order_window_end}`,
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
    '',
    `**Duplicates removed:** ${report.counts.duplicates_removed}  `,
    `**Final box count:** **${report.counts.final_box_count}**`,
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
    language: report.report_type === 'final' ? finalLanguage() : estimateLanguage(),
    counts: report.counts,
    warning_counts: report.warning_counts,
    warnings: report.warnings,
  }, null, 2);
}

function buildCsvRow(entry, report) {
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
    needs_review: entry.needs_review || '',
  };
}

function buildCsv(report) {
  const rows = report.entries.map((e) => buildCsvRow(e, report));
  // UTF-8 BOM + CRLF line endings for Excel friendliness.
  return stringifyObjects(rows, CSV_COLUMNS, { bom: true, eol: '\r\n' });
}

module.exports = {
  CSV_COLUMNS,
  buildMarkdown,
  buildJson,
  buildCsv,
  estimateLanguage,
  finalLanguage,
};
