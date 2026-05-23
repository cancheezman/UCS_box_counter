'use strict';

// Privacy utilities: masking helpers used in logs, errors, and warning
// messages. The full PII is intentionally kept in the customer-level CSV
// (that is the operational output) and in structured warning *context*
// fields, but it is NEVER embedded in human-readable log/warning *messages*
// that might be copy-pasted into chat, tickets, or screenshots.
//
// Masking rules:
//   maskEmail("alice@example.com")  -> "a***@e***.com"
//   maskEmail("a@b.co")             -> "a***@b***.co"
//   maskEmail("")                    -> ""
//   maskPhone("+1 555-010-1234")    -> "***-***-1234"
//   maskId("APP-1001")               -> "AP***01"  (keeps first 2 + last 2)
//   maskId("SH-2001")                -> "SH***01"
//   maskId("X")                      -> "***"
//
// These are best-effort obfuscation for operator-facing console/log output.
// They are not cryptographic. Do not rely on them for data sharing outside
// the operations team.

function maskEmail(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at < 0) return maskId(s);
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const localMasked = local.length > 0 ? `${local[0]}***` : '***';
  const dot = domain.lastIndexOf('.');
  let domainMasked;
  if (dot < 0) {
    domainMasked = domain.length > 0 ? `${domain[0]}***` : '***';
  } else {
    const name = domain.slice(0, dot);
    const tld = domain.slice(dot); // includes the leading "."
    domainMasked = `${name.length > 0 ? name[0] : ''}***${tld}`;
  }
  return `${localMasked}@${domainMasked}`;
}

function maskPhone(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  const digits = s.replace(/\D+/g, '');
  if (digits.length === 0) return '***';
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
}

function maskId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

// Mask a free-form address line. We only keep the street number (if present)
// and the first letter of the rest, since address-shape signals can still
// help an operator triage.
function maskAddress(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  const m = s.match(/^(\d+)/);
  const prefix = m ? `${m[1]} ` : '';
  return `${prefix}***`;
}

// Mask a person name to initials, e.g. "Alice Allen" -> "A. A.".
function maskName(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map((p) => `${p[0].toUpperCase()}.`).join(' ');
}

/**
 * Redact known PII fields from any object for safe console/log output.
 * Returns a shallow copy with email, phone, name, and address fields masked.
 * Other fields are passed through unchanged.
 */
function redactRecord(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  if ('customer_email' in out) out.customer_email = maskEmail(out.customer_email);
  if ('email' in out) out.email = maskEmail(out.email);
  if ('customer_name' in out) out.customer_name = maskName(out.customer_name);
  if ('shipping_name' in out) out.shipping_name = maskName(out.shipping_name);
  if ('phone' in out) out.phone = maskPhone(out.phone);
  if ('shipping_address_1' in out) out.shipping_address_1 = maskAddress(out.shipping_address_1);
  if ('shipping_address_2' in out) out.shipping_address_2 = out.shipping_address_2 ? '***' : '';
  if ('postal_code' in out && out.postal_code) {
    // Keep first character (region indicator) only.
    out.postal_code = `${String(out.postal_code).trim()[0] || ''}***`;
  }
  return out;
}

module.exports = {
  maskEmail,
  maskPhone,
  maskId,
  maskAddress,
  maskName,
  redactRecord,
};
