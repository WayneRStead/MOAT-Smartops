// src/components/PortfolioTiles.jsx
import React from "react";

export default function PortfolioTiles({
  accent = "#2a7fff",
  data,
  activeFilter,           // { domain, key } | null
  onChangeFilter,         // (next | null) => void
}) {
  // chip helper: small, RAG-colored, toggle behavior
  const Chip = ({ domain, keyName, label, tone }) => {
    const active = activeFilter && activeFilter.domain === domain && activeFilter.key === keyName;
    const bg = active ? toneBg(tone) : "#fff";
    const br = active ? toneStroke(tone) : "#e5e7eb";
    const fg = active ? toneFg(tone) : "#111827";
    return (
      <button
        type="button"
        onClick={() => onChangeFilter(active ? null : { domain, key: keyName })}
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] border"
        style={{ background: bg, borderColor: br, color: fg, lineHeight: 1.2 }}
        title={label}
      >
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: toneDot(tone) }} />
        {label}
      </button>
    );
  };

  // RAG palette
  const toneDot   = (t) => t==="g" ? "#10b981" : t==="a" ? "#f59e0b" : t==="r" ? "#ef4444" : "#6b7280";
  const toneBg    = (t) => t==="g" ? "rgba(16,185,129,.10)" : t==="a" ? "rgba(245,158,11,.10)" : t==="r" ? "rgba(239,68,68,.10)" : "rgba(107,114,128,.08)";
  const toneStroke= (t) => t==="g" ? "#10b981" : t==="a" ? "#f59e0b" : t==="r" ? "#ef4444" : "#d1d5db";
  const toneFg    = (t) => t==="r" ? "#991b1b" : t==="a" ? "#92400e" : t==="g" ? "#065f46" : "#374151";

  const Tile = ({ title, total, children }) => (
    <div className="tile">
      <div className="flex items-center justify-between mb-1">
        <div className="font-medium truncate">{title}{Number.isFinite(total) ? ` · ${total}` : ""}</div>
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );

  return (
    <div className="portfolio-grid">
      {/* HR */}
      <Tile title="HR" total={data.hr?.total}>
        <Chip domain="hr" keyName="present" label={`Present/In (${data.hr?.present||0})`} tone="g" />
        <Chip domain="hr" keyName="training_leave" label={`Training/Leave (${data.hr?.training_leave||0})`} tone="a" />
        <Chip domain="hr" keyName="sick" label={`Sick (${data.hr?.sick||0})`} tone="a" />
        <Chip domain="hr" keyName="iod" label={`IOD (${data.hr?.iod||0})`} tone="r" />
        <Chip domain="hr" keyName="overtime" label={`Overtime (${data.hr?.overtime||0})`} tone="a" />
      </Tile>

      {/* Projects */}
      <Tile title="Projects" total={data.projects?.total}>
        <Chip domain="projects" keyName="active"   label={`Active (${data.projects?.active||0})`}   tone="g" />
        <Chip domain="projects" keyName="paused"   label={`Paused (${data.projects?.paused||0})`}   tone="a" />
        <Chip domain="projects" keyName="overdue"  label={`Overdue (${data.projects?.overdue||0})`} tone="r" />
        <Chip domain="projects" keyName="closed"   label={`Closed (${data.projects?.closed||0})`}   tone="n" />
      </Tile>

      {/* Tasks */}
      <Tile title="Tasks" total={data.tasks?.total}>
        <Chip domain="tasks" keyName="in_progress" label={`In-Progress (${data.tasks?.in_progress||0})`} tone="g" />
        <Chip domain="tasks" keyName="paused_problem" label={`Paused+Problem (${data.tasks?.paused_problem||0})`} tone="a" />
        <Chip domain="tasks" keyName="completed" label={`Completed (${data.tasks?.completed||0})`} tone="n" />
      </Tile>

      {/* Assets */}
      <Tile title="Assets" total={data.assets?.total}>
        <Chip domain="assets" keyName="active" label={`Active (${data.assets?.active||0})`} tone="g" />
        <Chip domain="assets" keyName="maintenance" label={`Maintenance (${data.assets?.maintenance||0})`} tone="a" />
        <Chip domain="assets" keyName="retired" label={`Retired (${data.assets?.retired||0})`} tone="n" />
      </Tile>

      {/* Vehicles */}
      <Tile title="Vehicles" total={data.vehicles?.total}>
        <Chip domain="vehicles" keyName="active" label={`Active (${data.vehicles?.active||0})`} tone="g" />
        <Chip domain="vehicles" keyName="workshop" label={`Workshop (${data.vehicles?.workshop||0})`} tone="a" />
        <Chip domain="vehicles" keyName="retired" label={`Retired (${data.vehicles?.retired||0})`} tone="n" />
      </Tile>

      {/* Inspections */}
      <Tile title="Inspections" total={data.inspections?.total}>
        <Chip domain="inspections" keyName="passed" label={`Passed (${data.inspections?.passed||0})`} tone="g" />
        <Chip domain="inspections" keyName="failed" label={`Failed (${data.inspections?.failed||0})`} tone="r" />
        <Chip domain="inspections" keyName="all"    label={`All (${data.inspections?.total||0})`}  tone="n" />
      </Tile>

      {/* Clockings */}
      <Tile title="Clockings" total={data.clockings?.total}>
        <Chip domain="clockings" keyName="present_in" label={`Present/In (${data.clockings?.present_in||0})`} tone="g" />
        <Chip domain="clockings" keyName="training_leave" label={`Training/Leave (${data.clockings?.training_leave||0})`} tone="a" />
        <Chip domain="clockings" keyName="sick" label={`Sick (${data.clockings?.sick||0})`} tone="a" />
        <Chip domain="clockings" keyName="iod" label={`IOD (${data.clockings?.iod||0})`} tone="r" />
        <Chip domain="clockings" keyName="overtime" label={`Overtime (${data.clockings?.overtime||0})`} tone="a" />
      </Tile>

      {/* Invoices */}
      <Tile title="Invoices" total={data.invoices?.total}>
        <Chip domain="invoices" keyName="paid"        label={`Paid (${data.invoices?.paid||0})`} tone="g" />
        <Chip domain="invoices" keyName="submitted"   label={`Submitted (${data.invoices?.submitted||0})`} tone="a" />
        <Chip domain="invoices" keyName="outstanding" label={`Outstanding (${data.invoices?.outstanding||0})`} tone="r" />
        <Chip domain="invoices" keyName="completed"   label={`Completed (${data.invoices?.completed||0})`} tone="n" />
      </Tile>

      <style>{`
        .portfolio-grid{
          display:grid; gap:.6rem;
          grid-template-columns: repeat(2,minmax(0,1fr));
        }
        @media (min-width:900px){ .portfolio-grid{ grid-template-columns: repeat(3,minmax(0,1fr)); } }
        .tile{
          background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px;
        }
      `}</style>
    </div>
  );
}
