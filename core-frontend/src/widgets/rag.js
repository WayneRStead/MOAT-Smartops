// src/widgets/rag.js
// Shared helpers for the master RAG (red/amber/green) filter.
// Assumes FilterContext stores filters.rag as "", "green", "amber", or "red".

export function isRagActive(rag) {
  return rag === "green" || rag === "amber" || rag === "red";
}

// Map statuses per entity → which ones belong to each RAG bucket
export const RAG_RULES = {
  projects: {
    green: new Set(["active"]),
    amber: new Set(["paused"]),
    red:   new Set(["overdue", "closed-overdue"]), // "overdue" is what we compute client-side from dates
    // closed is intentionally excluded from RAG unless you decide otherwise
  },
  tasks: {
    green: new Set(["open","started","in-progress"]),
    amber: new Set(["paused","paused-problem","blocked","at-risk"]),
    red:   new Set(["overdue"]),
  },
  groups: {
    // we derive group status from the tasks associated to that group
    green: "green",
    amber: "amber",
    red:   "red",
  },
  people: {
    // derived from their linked tasks/projects
    green: "green",
    amber: "amber",
    red:   "red",
  },
};

// Normalize a plain status string for comparison (lowercase, dash-joined)
export function norm(v) {
  return String(v || "").toLowerCase().replace(/\s+/g, "-");
}

// Apply rag to a list (projects|tasks) using a getter that returns the normalized status
export function filterByRag({ rows, rag, entity, getStatus }) {
  if (!isRagActive(rag)) return rows;
  const rules = RAG_RULES[entity];
  if (!rules) return rows;
  const wanted = rules[rag];
  if (!wanted || !(wanted instanceof Set)) return rows;
  return rows.filter((r) => wanted.has(norm(getStatus(r))));
}

// Simple halo/pulse style toggles
export function haloStyle({ active, color }) {
  const col =
    color === "green" ? "0, 128, 0" :
    color === "amber" ? "209, 88, 12" :
    color === "red"   ? "192, 13, 13" : "37, 99, 235";
  return active
    ? { boxShadow: `0 0 0 4px rgba(${col}, .18)` }
    : {};
}
