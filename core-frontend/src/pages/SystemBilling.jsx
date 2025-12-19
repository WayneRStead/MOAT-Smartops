// src/pages/SystemBilling.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const monthStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

export default function SystemBilling() {
  const [month, setMonth] = useState(monthStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      // NOTE: api is already configured with /api base in your project
      const { data } = await api.get(`/billing/preview?month=${month}`);
      setData(data || null);
    } catch (e) {
      setErr(e?.response?.data?.error || "Failed to load billing preview");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const lines = useMemo(() => data?.lines || [], [data]);
  const subtotal = data?.subtotal ?? 0;
  const tax = data?.tax ?? 0;
  const total = data?.total ?? 0;
  const taxRate = data?.taxRate ?? 0;
  const orgName = data?.org?.name || "Current organisation";
  const seats = data?.org?.seats ?? null;

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold mb-1">Billing (Preview)</h1>
      <p className="text-sm text-gray-600 mb-4">
        This is a <strong>non-binding</strong> preview for{" "}
        <span className="font-semibold">{orgName}</span> for{" "}
        <span>{month}</span>.
      </p>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <label className="text-sm flex items-center gap-2">
          Month:
          <input
            className="border p-2 rounded text-sm"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <button
          className="px-3 py-2 border rounded text-sm"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>

        {seats != null && (
          <span className="ml-auto text-xs text-gray-500">
            Seats: <strong>{seats}</strong>
          </span>
        )}
      </div>

      {err && (
        <div className="text-red-600 mb-3 text-sm border border-red-200 bg-red-50 px-3 py-2 rounded">
          {err}
        </div>
      )}

      {loading ? (
        <div>Loading…</div>
      ) : !data ? (
        <div className="text-gray-600 text-sm">
          No billing data available for this month.
        </div>
      ) : lines.length === 0 ? (
        <div className="text-gray-600 text-sm">
          No metered usage for this month yet. Base seat line will appear once seats are configured and usage is recorded.
        </div>
      ) : (
        <>
          <table className="w-full border text-sm mb-3">
            <thead>
              <tr className="bg-gray-50">
                <th className="border p-2 text-left">Item</th>
                <th className="border p-2 text-left">Event</th>
                <th className="border p-2 text-right">Count</th>
                <th className="border p-2 text-right">Billable</th>
                <th className="border p-2 text-right">Unit</th>
                <th className="border p-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => (
                <tr key={idx}>
                  <td className="border p-2">{ln.label}</td>
                  <td className="border p-2 text-xs text-gray-500">
                    {ln.event}
                  </td>
                  <td className="border p-2 text-right">{ln.count}</td>
                  <td className="border p-2 text-right">{ln.billable}</td>
                  <td className="border p-2 text-right">
                    {(ln.unitPrice ?? 0).toFixed(3)}
                  </td>
                  <td className="border p-2 text-right">
                    {(ln.subtotal ?? 0).toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50">
                <td className="border p-2" colSpan={5}>
                  Subtotal
                </td>
                <td className="border p-2 text-right">
                  {subtotal.toFixed(3)}
                </td>
              </tr>
              <tr className="bg-gray-50">
                <td className="border p-2" colSpan={5}>
                  Tax ({(taxRate * 100).toFixed(1)}%)
                </td>
                <td className="border p-2 text-right">{tax.toFixed(3)}</td>
              </tr>
              <tr className="bg-gray-50 font-semibold">
                <td className="border p-2" colSpan={5}>
                  Total
                </td>
                <td className="border p-2 text-right">{total.toFixed(3)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
