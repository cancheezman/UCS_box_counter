'use strict';

// Minimal CSV reader/writer with quoted-field support and UTF-8 BOM handling.
// Zero runtime dependencies. Good enough for Appstle exports and our own output.

/** Strip a leading UTF-8 BOM if present. */
function stripBom(text) {
  if (typeof text !== 'string') return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into an array of row arrays.
 * Handles "quoted, fields", escaped "" quotes, and CRLF/LF line endings.
 */
function parseRows(text) {
  const src = stripBom(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Treat \r\n and lone \r as a row terminator.
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      if (i < len && src[i] === '\n') i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush the last field/row, but ignore a trailing empty line.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text into an array of plain objects keyed by header row.
 * Header names are trimmed.
 */
function parseObjects(text) {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => (h || '').trim());
  const out = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (row.length === 1 && row[0] === '') continue; // skip blank lines
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = c < row.length ? row[c] : '';
    }
    out.push(obj);
  }
  return out;
}

/** Quote a single CSV field if needed. Returns ASCII-safe text where possible. */
function escapeField(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Replace common smart punctuation with ASCII equivalents.
  s = s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize rows (array of arrays) to CSV text.
 * @param {Array<Array>} rows
 * @param {{ bom?: boolean, eol?: string }} [opts]
 */
function stringifyRows(rows, opts = {}) {
  const eol = opts.eol || '\r\n';
  const lines = rows.map((r) => r.map(escapeField).join(','));
  const body = lines.join(eol) + (rows.length > 0 ? eol : '');
  return (opts.bom === false ? '' : '﻿') + body;
}

/**
 * Serialize an array of objects to CSV text using `headers` for column order.
 */
function stringifyObjects(objects, headers, opts = {}) {
  const rows = [headers.slice()];
  for (const obj of objects) {
    rows.push(headers.map((h) => (obj[h] === undefined ? '' : obj[h])));
  }
  return stringifyRows(rows, opts);
}

module.exports = {
  stripBom,
  parseRows,
  parseObjects,
  escapeField,
  stringifyRows,
  stringifyObjects,
};
