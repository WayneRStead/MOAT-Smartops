// src/pages/OrgBilling.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

function fmtCurrency(amount, currency) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const num = Number(amount);
  return `${currency || ""} ${num.toFixed(2)}`;
}

function fmtMonthLabel(month) {
  // "2025-01" → "Jan 2025"
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return month || "—";
  const [y, m] = month.split("-");
  const dt = new Date(Number(y), Number(m) - 1, 1);
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
  });
}

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function daysUntil(dateLike) {
  if (!dateLike) return null;
  const d =
    typeof dateLike === "string" || typeof dateLike === "number"
      ? new Date(dateLike)
      : dateLike;
  if (!d || Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return Math.ceil(diffDays);
}

export default function OrgBilling() {
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [orgBilling, setOrgBilling] = useState(null); // /org/billing
  const [plans, setPlans] = useState([]); // /org/billing/plans

  const [selectedPlanCode, setSelectedPlanCode] = useState("");
  const [seatInput, setSeatInput] = useState("");

  const [preview, setPreview] = useState(null);
  const [previewMonth, setPreviewMonth] = useState(monthKey());

  async function loadAll(initialMonth = monthKey()) {
    setLoading(true);
    setErr("");
    setInfo("");
    try {
      const [billingRes, plansRes, previewRes] = await Promise.all([
        api.get("/org/billing"),
        api.get("/org/billing/plans"),
        api.get("/org/billing/preview", { params: { month: initialMonth } }),
      ]);

      const billingData = billingRes.data || null;
      const plansData = Array.isArray(plansRes.data) ? plansRes.data : [];
      const previewData = previewRes.data || null;

      setOrgBilling(billingData);
      setPlans(plansData);
      setPreview(previewData);
      setPreviewMonth(previewData?.month || initialMonth);

      // Default selected plan + seats from current billing
      if (billingData?.planCode) {
        setSelectedPlanCode(billingData.planCode);
      }
      const seats =
        typeof billingData?.seats === "number" ? billingData.seats : 0;
      setSeatInput(String(seats));

      setInfo("Billing information loaded.");
    } catch (e) {
      console.error("OrgBilling loadAll error:", e);
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.error ||
        (status === 404
          ? "Billing routes not found on backend (404). Did you restart the server with the new /org routes?"
          : String(e));
      setErr(msg);
      setPreview(null);
    } finally {
      setLoading(false);
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    // initial load
    loadAll(monthKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currency =
    orgBilling?.pricing?.currency ||
    orgBilling?.currency ||
    preview?.currency ||
    "ZAR";

  const lines = useMemo(() => preview?.lines || [], [preview]);

  async function reloadPreview(targetMonth) {
    if (!orgBilling) return;
    const monthParam = targetMonth || previewMonth || monthKey();
    setPreviewLoading(true);
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get("/org/billing/preview", {
        params: { month: monthParam },
      });
      setPreview(data || null);
      setPreviewMonth(data?.month || monthParam);
      setInfo(`Updated estimate for ${fmtMonthLabel(data?.month)}`);
    } catch (e) {
      console.error("OrgBilling reloadPreview error:", e);
      setErr(e?.response?.data?.error || String(e));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  function handleSeatsChange(e) {
    const v = e.target.value;
    setSeatInput(v);
  }

  async function handleSavePlanAndSeats() {
    if (!selectedPlanCode && seatInput === "") return;
    setErr("");
    setInfo("");

    const payload = {};
    if (selectedPlanCode) payload.planCode = selectedPlanCode;

    if (seatInput !== "") {
      const num = Number(seatInput);
      if (!Number.isFinite(num) || num < 0) {
        setErr("Seats must be a non-negative number.");
        return;
      }
      const currentSeats =
        typeof orgBilling?.seats === "number" ? orgBilling.seats : 0;
      if (num < currentSeats) {
        setErr(
          `You currently have ${currentSeats} seat${
            currentSeats === 1 ? "" : "s"
          }. Please contact your provider to reduce seats; you can only increase seats here.`
        );
        return;
      }
      payload.seats = num;
    }

    try {
      const { data } = await api.put("/org/billing", payload);
      setOrgBilling(data || null);
      setInfo("Plan / seats updated.");
      // refresh preview for current month with new pricing
      await reloadPreview();
    } catch (e) {
      console.error("OrgBilling handleSavePlanAndSeats error:", e);
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // Trial state helpers
  const isTrial =
    orgBilling?.status === "trialing" && orgBilling?.planCode === "trial";
  const isSuspendedTrial =
    orgBilling?.status === "suspended" && orgBilling?.planCode === "trial";
  const trialEndsAt = orgBilling?.trialEndsAt;
  const trialDaysLeft = daysUntil(trialEndsAt);

  const hasCustomLabel =
    orgBilling?.plan &&
    orgBilling?.planCode &&
    orgBilling.plan.trim().toLowerCase() !==
      orgBilling.planCode.trim().toLowerCase();

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Billing &amp; Plans</h1>
          <p className="text-sm text-gray-500 mt-1">
            Choose the plan that fits your organisation and manage your active
            seats. Prices below are per-organisation, per-month before
            usage-based metered events.
          </p>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => loadAll(previewMonth || monthKey())}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Alerts */}
      <div className="space-y-1">
        {err && (
          <div className="px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm border border-red-200">
            {err}
          </div>
        )}
        {info && (
          <div className="px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-sm border border-emerald-200">
            {info}
          </div>
        )}

        {/* Trial banner */}
        {orgBilling && (isTrial || isSuspendedTrial) && (
          <div
            className={`px-3 py-2 rounded-lg text-sm border ${
              isSuspendedTrial || (trialDaysLeft != null && trialDaysLeft <= 0)
                ? "bg-red-50 text-red-700 border-red-200"
                : trialDaysLeft != null && trialDaysLeft <= 7
                ? "bg-amber-50 text-amber-800 border-amber-200"
                : "bg-sky-50 text-sky-800 border-sky-200"
            }`}
          >
            {isSuspendedTrial || (trialDaysLeft != null && trialDaysLeft <= 0) ? (
              <>
                <strong>Your trial has expired.</strong>{" "}
                Please choose a paid plan below or contact your provider to
                restore access.
                {trialEndsAt && (
                  <span className="ml-1 text-xs opacity-80">
                    (Trial ended on{" "}
                    {new Date(trialEndsAt).toLocaleDateString()}
                    )
                  </span>
                )}
              </>
            ) : (
              <>
                <strong>Trial plan active.</strong>{" "}
                {trialEndsAt && (
                  <>
                    Your trial ends on{" "}
                    <span className="font-semibold">
                      {new Date(trialEndsAt).toLocaleDateString()}
                    </span>
                    .
                  </>
                )}{" "}
                {trialDaysLeft != null && trialDaysLeft > 0 && (
                  <span className="text-xs ml-1">
                    ({trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"} left)
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {!orgBilling && !loading && (
        <div className="px-3 py-2 rounded-lg bg-gray-50 text-gray-600 text-sm border border-gray-200">
          Billing information is not available yet.
        </div>
      )}

      {orgBilling && (
        <>
          {/* Current plan card */}
          <div className="p-4 rounded-2xl border bg-white shadow-sm space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold m-0">Current plan</h2>
                <p className="text-xs text-gray-500">
                  Your plan controls base monthly fee, included seats and
                  usage-based pricing.
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3 text-sm mt-3">
              <div>
                <div className="text-xs text-gray-500">Plan label</div>
                <div className="mt-1 font-semibold">
                  {orgBilling.plan || orgBilling.planCode || "Trial"}
                </div>
                <div className="mt-1 text-xs text-gray-500 flex items-center gap-1">
                  Plan code:{" "}
                  <span className="font-mono">
                    {orgBilling.planCode || "trial"}
                  </span>
                  {hasCustomLabel && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 text-[10px]">
                      Custom label set by provider
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  Status:{" "}
                  <span className="font-medium">
                    {orgBilling.status || "trialing"}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Seats in use</div>
                <div className="mt-1 font-semibold">
                  {typeof orgBilling.seats === "number"
                    ? `${orgBilling.seats} seat${
                        orgBilling.seats === 1 ? "" : "s"
                      }`
                    : "Not set"}
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  Seat changes via this screen can only{" "}
                  <span className="font-semibold">increase</span> your seats.
                  To reduce seats, please contact your provider.
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Effective pricing</div>
                <ul className="mt-1 text-xs space-y-1">
                  <li>
                    Base:{" "}
                    <span className="font-medium">
                      {orgBilling.pricing?.basePrice != null
                        ? fmtCurrency(orgBilling.pricing.basePrice, currency)
                        : "—"}
                    </span>
                  </li>
                  <li>
                    Included seats:{" "}
                    <span className="font-medium">
                      {orgBilling.pricing?.includedSeats ?? "—"}
                    </span>
                  </li>
                  <li>
                    Extra seat:{" "}
                    <span className="font-medium">
                      {orgBilling.pricing?.extraSeatPrice != null
                        ? fmtCurrency(
                            orgBilling.pricing.extraSeatPrice,
                            currency
                          )
                        : "—"}
                    </span>
                  </li>
                  <li>
                    Tax:{" "}
                    <span className="font-medium">
                      {((orgBilling.pricing?.taxRate ?? 0) * 100).toFixed(1)}%
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* Plan selector */}
          <div className="p-4 rounded-2xl border bg-white shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold m-0">
                  Choose a subscription plan
                </h2>
                <p className="text-xs text-gray-500">
                  Plans and pricing are configured globally by MOAT. Choose the
                  plan that best matches your team size and usage. You&apos;ll
                  see an updated monthly estimate below.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  Seats
                  <input
                    className="input input-bordered input-xs w-20"
                    type="number"
                    min={0}
                    value={seatInput}
                    onChange={handleSeatsChange}
                  />
                </label>
                <button
                  className="btn btn-xs btn-primary"
                  onClick={handleSavePlanAndSeats}
                  disabled={loading}
                >
                  {loading ? "Updating…" : "Save plan & seats"}
                </button>
              </div>
            </div>

            {plans.length ? (
              <div className="grid gap-3 md:grid-cols-3 mt-2">
                {plans.map((p) => {
                  const isSelected = p.planCode === selectedPlanCode;
                  const planLabel = p.label || p.planCode;
                  const customLabelHere =
                    planLabel &&
                    p.planCode &&
                    planLabel.trim().toLowerCase() !==
                      p.planCode.trim().toLowerCase();
                  return (
                    <button
                      key={p.planCode}
                      type="button"
                      onClick={() => setSelectedPlanCode(p.planCode)}
                      className={`text-left p-3 rounded-xl border transition shadow-sm ${
                        isSelected
                          ? "border-emerald-500 bg-emerald-50"
                          : "border-gray-200 bg-white hover:border-emerald-300"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold text-sm">{planLabel}</div>
                        <div className="text-[11px] font-mono uppercase text-gray-500">
                          {p.planCode}
                        </div>
                      </div>
                      {customLabelHere && (
                        <div className="mt-1 text-[10px] inline-flex items-center px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                          Custom marketing label
                        </div>
                      )}
                      <div className="mt-2 text-lg font-bold">
                        {p.basePrice != null
                          ? fmtCurrency(p.basePrice, p.currency || currency)
                          : "Custom"}
                        <span className="text-xs text-gray-500 font-normal">
                          /mo
                        </span>
                      </div>
                      <ul className="mt-2 text-xs text-gray-600 space-y-1">
                        <li>
                          Included seats:{" "}
                          <span className="font-medium">
                            {p.includedSeats ?? "—"}
                          </span>
                        </li>
                        <li>
                          Extra seat:{" "}
                          <span className="font-medium">
                            {p.extraSeatPrice != null
                              ? fmtCurrency(
                                  p.extraSeatPrice,
                                  p.currency || currency
                                )
                              : "—"}
                            /seat
                          </span>
                        </li>
                        <li>
                          Tax:{" "}
                          <span className="font-medium">
                            {((p.taxRate ?? 0) * 100).toFixed(1)}%
                          </span>
                        </li>
                      </ul>
                      {isSelected && (
                        <div className="mt-2 text-[11px] text-emerald-700 font-medium">
                          Selected
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-2 rounded-lg bg-gray-50 text-gray-500 text-xs border border-dashed border-gray-200">
                No plans are configured yet. A global superadmin must define
                billing plans first.
              </div>
            )}
          </div>
        </>
      )}

      {/* Monthly preview */}
      {orgBilling && (
        <div className="p-4 rounded-2xl border bg-white shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold m-0">
                Monthly estimate ({currency})
              </h2>
              <p className="text-xs text-gray-500">
                This is a preview only. Final invoices may adjust for late
                events or manual corrections.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1">
                Month
                <input
                  className="input input-bordered input-xs w-24"
                  type="text"
                  value={previewMonth}
                  onChange={(e) => setPreviewMonth(e.target.value)}
                  placeholder="YYYY-MM"
                />
              </label>
              <button
                className="btn btn-xs"
                onClick={() => reloadPreview()}
                disabled={previewLoading}
              >
                {previewLoading ? "Loading…" : "Load"}
              </button>
              <button
                className="btn btn-xs btn-ghost"
                type="button"
                onClick={() => {
                  const mk = monthKey();
                  setPreviewMonth(mk);
                  reloadPreview(mk);
                }}
              >
                This month
              </button>
            </div>
          </div>

          {!preview && !previewLoading && (
            <div className="px-3 py-2 rounded-lg bg-gray-50 text-gray-500 text-xs border border-gray-200">
              No preview available yet for this month.
            </div>
          )}

          {preview && (
            <>
              <div className="grid gap-4 md:grid-cols-3 text-sm">
                <div>
                  <div className="text-xs text-gray-500">Month</div>
                  <div className="mt-1 font-semibold">
                    {fmtMonthLabel(preview.month)}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500 font-mono">
                    {preview.month}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Plan / seats</div>
                  <div className="mt-1 font-semibold">
                    {preview.planCode || orgBilling.planCode || "—"}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {typeof preview.seats === "number"
                      ? `${preview.seats} seat${
                          preview.seats === 1 ? "" : "s"
                        }`
                      : typeof orgBilling.seats === "number"
                      ? `${orgBilling.seats} seat${
                          orgBilling.seats === 1 ? "" : "s"
                        }`
                      : "Seats not set"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">
                    Total (incl. tax)
                  </div>
                  <div className="mt-1 text-2xl font-bold">
                    {fmtCurrency(preview.total || 0, currency)}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Subtotal: {fmtCurrency(preview.subtotal || 0, currency)} ·
                    Tax{" "}
                    {(
                      (preview.taxRate ?? orgBilling.pricing?.taxRate ?? 0) *
                      100
                    ).toFixed(1)}
                    % = {fmtCurrency(preview.tax || 0, currency)}
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                    Usage breakdown
                  </div>
                  <div className="text-[11px] text-gray-500">
                    Amounts in {currency}.
                  </div>
                </div>
                <div className="overflow-auto -mx-2 px-2 max-h-[320px]">
                  <table className="table w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th>Code</th>
                        <th className="text-right">Count</th>
                        <th className="text-right">Free</th>
                        <th className="text-right">Billable</th>
                        <th className="text-right">Unit price</th>
                        <th className="text-right">Line total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.length ? (
                        lines.map((ln, idx) => (
                          <tr key={`${ln.code || "line"}-${idx}`}>
                            <td className="align-top font-mono text-[11px]">
                              {ln.code}
                            </td>
                            <td className="align-top text-right">
                              {ln.count ?? "—"}
                            </td>
                            <td className="align-top text-right">
                              {ln.free ?? 0}
                            </td>
                            <td className="align-top text-right">
                              {ln.billable ?? ln.count ?? "—"}
                            </td>
                            <td className="align-top text-right">
                              {ln.unitPrice != null
                                ? Number(ln.unitPrice).toFixed(3)
                                : "—"}
                            </td>
                            <td className="align-top text-right">
                              {fmtCurrency(ln.subtotal || 0, currency)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td
                            colSpan={6}
                            className="p-3 text-center text-gray-500 text-xs"
                          >
                            No usage for this month.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
