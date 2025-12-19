import React from "react";

export default function WidgetFrame({ title, loading, error, children, right = null }) {
  return (
    <div className="rounded-xl border border-border bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">{title}</div>
        {right}
      </div>
      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-600">{error}</div>
      ) : (
        children || <div className="text-sm text-gray-500">No data</div>
      )}
    </div>
  );
}
