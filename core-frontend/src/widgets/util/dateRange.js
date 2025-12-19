// Shared date-range helpers for widgets

/** Normalize a date-range object coming from FilterContext. */
export function normalizeDR(dr = {}) {
  const fromAt = dr.fromAt || (dr.from ? toISOStart(dr.from) : null);
  const toAt   = dr.toAt   || (dr.to ? toISOEnd(dr.to)     : null);
  return { fromAt, toAt };
}

function toISOStart(dStr) {
  // Treat input as local date (YYYY-MM-DD or Date-compatible)
  const d = new Date(dStr);
  if (isNaN(+d)) return null;
  d.setHours(0,0,0,0);
  return d.toISOString();
}
function toISOEnd(dStr) {
  const d = new Date(dStr);
  if (isNaN(+d)) return null;
  d.setHours(23,59,59,999);
  return d.toISOString();
}

/** Inclusive range check for an ISO-like timestamp against FilterContext dr. */
export function inRangeInclusiveISO(isoLike, dr = {}) {
  if (!isoLike) return true; // if row has no time, don't exclude it
  const { fromAt, toAt } = normalizeDR(dr);
  if (!fromAt && !toAt) return true;

  const x = new Date(isoLike);
  if (isNaN(+x)) return true;

  if (fromAt && x < new Date(fromAt)) return false;
  if (toAt && x > new Date(toAt)) return false;
  return true;
}

/**
 * Attach range params for API calls (be generous with names —
 * different endpoints prefer different keys).
 */
export function addRangeToParams(dr = {}, base = {}) {
  const { fromAt, toAt } = normalizeDR(dr);
  const out = { ...base };
  if (fromAt) {
    out.start = fromAt; out.fromAt = fromAt; out.from = fromAt;
  }
  if (toAt) {
    out.end = toAt; out.toAt = toAt; out.to = toAt;
  }
  return out;
}
