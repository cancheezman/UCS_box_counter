'use strict';

// Public entry point. Re-exports the modules used by the CLI and tests.

const dates = require('./dates');
const product = require('./product');
const prepaid = require('./prepaid');
const normalize = require('./normalize');
const eligibility = require('./eligibility');
const dedupe = require('./dedupe');
const warnings = require('./warnings');
const count = require('./count');
const shopify = require('./shopify');
const report = require('./report');
const csv = require('./csv');
const privacy = require('./privacy');
const connector = require('./connector');
const schedule = require('./schedule');
const overrides = require('./overrides');

module.exports = {
  ...dates,
  product,
  prepaid,
  normalize,
  eligibility,
  ...dedupe,
  warnings,
  ...count,
  shopify,
  report,
  csv,
  privacy,
  connector,
  schedule,
  overrides,
};
