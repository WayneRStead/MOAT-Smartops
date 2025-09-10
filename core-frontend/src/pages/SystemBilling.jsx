import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const monthStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

export default function SystemBilling() {
  const [month, setMonth] = useState(monthStr());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const { data } = await api.get(`/billing/preview?month=${month}`);
      setRows(data || []);
    } catch (e) {
      setErr(e?.response?.data?.error || "Failed to load billing preview");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [month]);

  const flat = useMemo(() => {
    const out = [];
    for (const org of rows) {
      for (const item of org.items || []) {
        out.push({
          orgId: org.orgId,
          event: item.event,
          count: item.count,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal,
        });
      }
    }
    return out;
  }, [rows]);

  const total = flat.reduce((s, r) => s + (r.subtotal || 0), 0);

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold mb-3">Billing (Preview)</h1>

      <div className="flex items-center gap-2 mb-3">
        <label>Month:</label>
        <input
          className="border p-2"
          type="month"
          value={month}
          onChange={(e)=>setMonth(e.target.value)}
        />
        <button className="px-3 py-2 border rounded" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {err && <div className="text-red-600 mb-3">{err}</div>}
      {loading ? (
        <div>Loading…</div>
      ) : (
        <>
          <table className="w-full border text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="border p-2 text-left">Org</th>
                <th className="border p-2 text-left">Event</th>
                <th className="border p-2 text-right">Count</th>
                <th className="border p-2 text-right">Unit</th>
                <th className="border p-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {flat.map((r, i) => (
                <tr key={i}>
                  <td className="border p-2">{String(r.orgId)}</td>
                  <td className="border p-2">{r.event}</td>
                  <td className="border p-2 text-right">{r.count}</td>
                  <td className="border p-2 text-right">{(r.unitPrice ?? 0).toFixed(3)}</td>
                  <td className="border p-2 text-right">{(r.subtotal ?? 0).toFixed(3)}</td>
                </tr>
              ))}
              {flat.length === 0 && (
                <tr><td className="p-4 text-center" colSpan={5}>No usage this month</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold">
                <td className="border p-2" colSpan={4}>Total</td>
                <td className="border p-2 text-right">{total.toFixed(3)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
