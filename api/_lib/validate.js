import { HttpError } from './http.js';
import { POOLS } from './redis.js';

const ID_RE = /^[a-f0-9]{16}$/;
// Letters, marks, numbers, spaces and a little punctuation common in names.
const NAME_RE = /^[\p{L}\p{M}\p{N} .,'’()&\-]+$/u;

export function bad(message, code = 'VALIDATION') {
  return new HttpError(400, message, code);
}

export function id(value, field = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw bad(`Invalid ${field}`);
  return value;
}

export function name(value, field = 'name', max = 60) {
  if (typeof value !== 'string') throw bad(`${field} is required`);
  const v = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!v) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field} must be ${max} characters or fewer`);
  if (!NAME_RE.test(v)) throw bad(`${field} contains unsupported characters`);
  return v;
}

// Normalized form used for duplicate-name detection.
export function nameKey(v) {
  return v.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

export function category(value) {
  if (!POOLS.includes(value)) throw bad('category must be "adult" or "child"');
  return value;
}

export function pool(value) {
  if (!POOLS.includes(value)) throw bad('pool must be "adult" or "child"');
  return value;
}

export function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${field} must be text`);
  // Strip control characters except newlines/tabs.
  const v = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (v.length > max) throw bad(`${field} must be ${max} characters or fewer`);
  return v;
}

export function isoDate(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw bad(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
}
