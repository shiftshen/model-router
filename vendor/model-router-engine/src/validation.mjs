const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function assertPlainObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value;
}

export function assertKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${field} contains unsupported field: ${key}`);
  }
}

export function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

export function assertIdentifier(value, field) {
  const normalized = assertNonEmptyString(value, field);
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new TypeError(`${field} contains unsupported characters`);
  return normalized;
}

export function assertStringArray(value, field, { defaultValue = [], requireNonEmpty = false, identifiers = true } = {}) {
  const resolved = value === undefined ? defaultValue : value;
  if (!Array.isArray(resolved)) throw new TypeError(`${field} must be an array`);
  if (requireNonEmpty && resolved.length === 0) throw new TypeError(`${field} must not be empty`);
  const validate = identifiers ? assertIdentifier : assertNonEmptyString;
  return [...new Set(resolved.map((item, index) => validate(item, `${field}[${index}]`)))];
}

export function assertRatio(value, field, { nullable = true } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${field} must be a number from 0 to 1`);
  return value;
}

export function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

export function assertNonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return value;
}

export function assertBoolean(value, field) {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

export function assertIsoDate(value, field) {
  const normalized = assertNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(normalized))) throw new TypeError(`${field} must be an ISO-8601 date-time`);
  return normalized;
}

export function cloneJson(value, field = "value") {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, `${field}[${index}]`));
  assertPlainObject(value, field);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry, `${field}.${key}`)]));
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}
