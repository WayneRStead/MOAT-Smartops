import { useEffect, useMemo, useRef, useState } from "react";

export default function GroupSelect({ value, onChange, placeholder = "Select a group...", disabled }) {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const token = useMemo(() => localStorage.getItem("token"), []);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  // debounced fetch
  useEffect(() => {
    let stop = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const url = new URL("/api/groups", window.location.origin);
        if (q) url.searchParams.set("q", q);
        url.searchParams.set("limit", "50");
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        });
        const data = await res.json();
        if (!stop) setRows(Array.isArray(data) ? data : []);
      } catch {
        if (!stop) setRows([]);
      } finally {
        if (!stop) setLoading(false);
      }
    }, 200);
    return () => { stop = true; clearTimeout(t); };
  }, [q, token]);

  const selected = rows.find(r => String(r._id) === String(value));

  return (
    <div ref={boxRef} style={{ position: "relative", width: "100%" }}>
      <div
        onClick={() => !disabled && setOpen(v => !v)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
          background: disabled ? "var(--muted)" : "transparent", cursor: disabled ? "not-allowed" : "pointer"
        }}
      >
        <span style={{ color: selected ? "inherit" : "var(--muted-foreground)" }}>
          {selected ? selected.name : placeholder}
        </span>
        <span style={{ opacity: 0.7 }}>▾</span>
      </div>

      {open && !disabled && (
        <div
          style={{
            position: "absolute", zIndex: 20, top: "110%", left: 0, right: 0,
            border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)",
            boxShadow: "0 6px 20px rgba(0,0,0,.15)"
          }}
        >
          <div style={{ padding: 8 }}>
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search groups…"
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 6,
                border: "1px solid var(--border)", background: "transparent", color: "inherit"
              }}
            />
          </div>

          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {loading && <div style={{ padding: 10, opacity: 0.7 }}>Loading…</div>}
            {!loading && rows.length === 0 && (
              <div style={{ padding: 10, opacity: 0.7 }}>No groups</div>
            )}
            {rows.map((g) => (
              <div
                key={g._id}
                onClick={() => { onChange?.(g._id, g); setOpen(false); }}
                style={{
                  padding: "8px 10px",
                  background: String(value) === String(g._id) ? "var(--accent)" : "transparent",
                  cursor: "pointer"
                }}
              >
                <div style={{ fontWeight: 600 }}>{g.name}</div>
                {g.description ? (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{g.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
