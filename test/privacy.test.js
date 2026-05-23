'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  maskEmail, maskPhone, maskId, maskAddress, maskName, redactRecord,
} = require('../src/privacy');

test('maskEmail: typical address', () => {
  assert.equal(maskEmail('alice@example.com'), 'a***@e***.com');
});

test('maskEmail: short local part', () => {
  assert.equal(maskEmail('a@b.co'), 'a***@b***.co');
});

test('maskEmail: empty and nullish are safe', () => {
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail(null), '');
  assert.equal(maskEmail(undefined), '');
});

test('maskEmail: no @ falls back to maskId', () => {
  assert.equal(maskEmail('not-an-email'), 'no***il');
});

test('maskEmail: domain without TLD', () => {
  assert.equal(maskEmail('a@localhost'), 'a***@l***');
});

test('maskPhone: keeps last 4 digits', () => {
  assert.equal(maskPhone('+1 555-010-1234'), '***-***-1234');
  assert.equal(maskPhone('5550101234'), '***-***-1234');
});

test('maskPhone: short / non-numeric inputs', () => {
  assert.equal(maskPhone('ext.'), '***');
  assert.equal(maskPhone(''), '');
});

test('maskId: keeps first 2 and last 2 chars', () => {
  assert.equal(maskId('APP-1001'), 'AP***01');
  assert.equal(maskId('SH-2001'), 'SH***01');
});

test('maskId: short ids collapse to ***', () => {
  assert.equal(maskId('X'), '***');
  assert.equal(maskId('AB'), '***');
});

test('maskAddress: keeps street number only', () => {
  assert.equal(maskAddress('1 Main St'), '1 ***');
  assert.equal(maskAddress('Box 42'), '***');
});

test('maskName: initials only', () => {
  assert.equal(maskName('Alice Allen'), 'A. A.');
  assert.equal(maskName('  carol  chen '), 'C. C.');
});

test('redactRecord masks PII fields, leaves others intact', () => {
  const r = redactRecord({
    customer_email: 'alice@example.com',
    customer_name: 'Alice Allen',
    phone: '+1 555-010-1234',
    shipping_address_1: '1 Main St',
    shipping_address_2: 'Apt 3',
    postal_code: '11201',
    subscription_id: 'APP-1001',
    target_box_month: '2026-06',
  });
  assert.equal(r.customer_email, 'a***@e***.com');
  assert.equal(r.customer_name, 'A. A.');
  assert.equal(r.phone, '***-***-1234');
  assert.equal(r.shipping_address_1, '1 ***');
  assert.equal(r.shipping_address_2, '***');
  assert.equal(r.postal_code, '1***');
  assert.equal(r.subscription_id, 'APP-1001'); // IDs preserved unless explicitly masked
  assert.equal(r.target_box_month, '2026-06');
});

test('redactRecord on null / non-object is a no-op', () => {
  assert.equal(redactRecord(null), null);
  assert.equal(redactRecord(undefined), undefined);
  assert.equal(redactRecord('hello'), 'hello');
});
