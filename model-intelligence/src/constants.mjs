export const MODEL_STATUSES = Object.freeze([
  "preferred",
  "qualified",
  "experimental",
  "degraded",
  "manual_only",
  "blocked",
]);

export const CREDENTIAL_STATUSES = Object.freeze([
  "active",
  "degraded",
  "missing",
  "invalid",
  "exhausted",
]);

export const PRIVACY_LEVELS = Object.freeze({
  remote: 0,
  "private-cloud": 1,
  local: 2,
});

export const PRIORITY_LEVELS = Object.freeze(["low", "medium", "high"]);

export const TIER_VALUES = Object.freeze({ low: 1, medium: 2, high: 3 });

export const FAILURE_CATEGORIES = Object.freeze([
  "timeout",
  "transport",
  "authentication",
  "quota",
  "context_overflow",
  "invalid_format",
  "quality_failure",
  "tool_failure",
  "safety_rejection",
  "unknown",
]);
