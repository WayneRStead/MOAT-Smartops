// src/pages/SuperAdminDashboard.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

// Simple pill component
function Pill({ children, tone = "default" }) {
  const tones = {
    default: "bg-gray-100 text-gray-700",
    ok: "bg-green-100 text-green-700",
    warn: "bg-yellow-100 text-yellow-800",
    bad: "bg-red-100 text-red-700",
  };
  const cls = tones[tone] || tones.default;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>
      {children}
    </span>
  );
}

// Small helper: safely stringify IDs
const idStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v._id || v.id || v);
  return String(v);
};

// Date formatting helpers
function fmtDate(d) {
  if (!d) return "—";
  const dt =
    typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  if (!dt || Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function fmtDateTime(d) {
  if (!d) return "—";
  const dt =
    typeof d === "string" || typeof d === "number" ? new Date(d) : d;
  if (!dt || Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SuperAdminDashboard() {
  const [overview, setOverview] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [users, setUsers] = useState([]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // filters for orgs/users
  const [orgSearch, setOrgSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [orgSearchDeb, setOrgSearchDeb] = useState("");
  const [userSearchDeb, setUserSearchDeb] = useState("");

  // Billing defaults (global)
  const [billingDefaults, setBillingDefaults] = useState(null);
  const [savingDefaults, setSavingDefaults] = useState(false);

  // Per-org billing modal
  const [billingOrg, setBillingOrg] = useState(null);
  const [billingOrgConfig, setBillingOrgConfig] = useState(null);
  const [savingOrgBilling, setSavingOrgBilling] = useState(false);

  // Plan-level pricing
  const [plans, setPlans] = useState([]);
  const [planModal, setPlanModal] = useState(null);
  const [savingPlan, setSavingPlan] = useState(false);

  // Per-org billing preview modal
  const [billingPreviewOrg, setBillingPreviewOrg] = useState(null);
  const [billingPreview, setBillingPreview] = useState(null);
  const [billingPreviewMonth, setBillingPreviewMonth] = useState("");
  const [billingPreviewLoading, setBillingPreviewLoading] = useState(false);

  // debounce filters slightly
  useEffect(() => {
    const t = setTimeout(
      () => setOrgSearchDeb(orgSearch.trim().toLowerCase()),
      200
    );
    return () => clearTimeout(t);
  }, [orgSearch]);

  useEffect(() => {
    const t = setTimeout(
      () => setUserSearchDeb(userSearch.trim().toLowerCase()),
      200
    );
    return () => clearTimeout(t);
  }, [userSearch]);

  async function load() {
    setErr("");
    setInfo("");
    setLoading(true);
    try {
      const [ovRes, orgRes, userRes, billingDefRes, plansRes] =
        await Promise.all([
          api.get("/admin/super/overview"),
          api.get("/admin/super/orgs"),
          api.get("/admin/super/users"),
          api.get("/admin/super/billing-defaults"),
          api.get("/admin/super/billing-plans"),
        ]);
      setOverview(ovRes.data || null);
      setOrgs(Array.isArray(orgRes.data) ? orgRes.data : []);
      setUsers(Array.isArray(userRes.data) ? userRes.data : []);
      setBillingDefaults(billingDefRes.data || null);
      setPlans(Array.isArray(plansRes.data) ? plansRes.data : []);
    } catch (e) {
      console.error("Super admin load error:", e);
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filteredOrgs = useMemo(() => {
    const needle = orgSearchDeb;
    if (!needle) return orgs;
    return (orgs || []).filter((o) => {
      const hay = `${o.name || ""} ${o.status || ""} ${
        o.ownerEmail || ""
      } ${o.plan || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [orgs, orgSearchDeb]);

  const filteredUsers = useMemo(() => {
    const needle = userSearchDeb;
    if (!needle) return users;
    return (users || []).filter((u) => {
      const hay = `${u.name || ""} ${u.email || ""} ${u.role || ""} ${
        u.orgId || ""
      }`.toLowerCase();
      return hay.includes(needle);
    });
  }, [users, userSearchDeb]);

  function statusTone(status) {
    if (status === "active" || status === "trialing") return "ok";
    if (status === "pending") return "warn";
    if (status === "suspended" || status === "cancelled") return "bad";
    return "default";
  }

  async function toggleGlobalSuper(u) {
    if (!u || !u._id) return;
    const turnOn = !u.isGlobalSuperadmin;
    if (
      !window.confirm(
        `${turnOn ? "Promote" : "Remove"} global superadmin for ${
          u.name || u.email || idStr(u._id)
        }?`
      )
    ) {
      return;
    }
    setErr("");
    setInfo("");
    try {
      await api.post(`/admin/super/users/${u._id}/global-super`, {
        on: turnOn,
      });
      setInfo("Global superadmin flag updated.");
      await load();
    } catch (e) {
      console.error("toggleGlobalSuper error:", e);
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const totalGlobalSupers = useMemo(
    () => (users || []).filter((u) => u.isGlobalSuperadmin).length,
    [users]
  );

  /* -------- Global billing defaults UI handlers -------- */

  const billingKeys = useMemo(() => {
    if (!billingDefaults?.rates) return [];
    return Object.keys(billingDefaults.rates).sort();
  }, [billingDefaults]);

  function changeDefaultRate(code, value) {
    if (!billingDefaults) return;
    const num = value === "" ? "" : Number(value);
    setBillingDefaults((prev) => ({
      ...prev,
      rates: {
        ...(prev?.rates || {}),
        [code]: value === "" ? "" : isNaN(num) ? 0 : num,
      },
    }));
  }

  function changeDefaultAllowance(code, value) {
    if (!billingDefaults) return;
    const num = value === "" ? "" : Number(value);
    setBillingDefaults((prev) => ({
      ...prev,
      allowances: {
        ...(prev?.allowances || {}),
        [code]: value === "" ? "" : isNaN(num) ? 0 : num,
      },
    }));
  }

  function changeDefaultTaxRate(value) {
    const num = value === "" ? "" : Number(value);
    setBillingDefaults((prev) => ({
      ...(prev || {}),
      taxRate: value === "" ? "" : isNaN(num) ? 0 : num,
    }));
  }

  function changeDefaultCurrency(value) {
    setBillingDefaults((prev) => ({
      ...(prev || {}),
      currency: value || "",
    }));
  }

  async function saveBillingDefaults() {
    if (!billingDefaults) return;
    setSavingDefaults(true);
    setErr("");
    setInfo("");
    try {
      // Clean payload (convert "" → undefined / drop)
      const cleanRates = {};
      Object.entries(billingDefaults.rates || {}).forEach(([k, v]) => {
        if (v === "" || v == null) return;
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        cleanRates[k] = num;
      });

      const cleanAllowances = {};
      Object.entries(billingDefaults.allowances || {}).forEach(([k, v]) => {
        if (v === "" || v == null) return;
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        cleanAllowances[k] = num;
      });

      let taxRate = billingDefaults.taxRate;
      if (taxRate === "") taxRate = undefined;
      else if (typeof taxRate !== "number") {
        const num = Number(taxRate);
        taxRate = Number.isFinite(num) ? num : undefined;
      }

      const payload = {
        rates: cleanRates,
        allowances: cleanAllowances,
        taxRate,
        currency: billingDefaults.currency || undefined,
      };
      const { data } = await api.put(
        "/admin/super/billing-defaults",
        payload
      );
      setBillingDefaults(data || null);
      setInfo("Billing defaults updated.");
    } catch (e) {
      console.error("saveBillingDefaults error:", e);
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setSavingDefaults(false);
    }
  }

  /* -------- Per-org billing modal handlers -------- */

  async function openOrgBilling(o) {
    if (!o || !o._id) return;
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get(`/admin/super/orgs/${o._id}/billing`);
      setBillingOrg(o);
      setBillingOrgConfig({
        ...data,
        billingOverrides: data.billingOverrides || {},
      });
    } catch (e) {
      console.error("openOrgBilling error:", e);
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function closeOrgBilling() {
    setBillingOrg(null);
    setBillingOrgConfig(null);
  }

  function updateOrgBillingField(field, value) {
    if (!billingOrgConfig) return;
    setBillingOrgConfig((prev) => ({
      ...prev,
      [field]: value,
    }));
  }

  function updateOrgOverrideRate(code, value) {
    setBillingOrgConfig((prev) => {
      if (!prev) return prev;
      const num = value === "" ? "" : Number(value);
      return {
        ...prev,
        billingOverrides: {
          ...(prev.billingOverrides || {}),
          rates: {
            ...((prev.billingOverrides && prev.billingOverrides.rates) || {}),
            [code]: value === "" ? undefined : isNaN(num) ? 0 : num,
          },
        },
      };
    });
  }

  function updateOrgOverrideAllowance(code, value) {
    setBillingOrgConfig((prev) => {
      if (!prev) return prev;
      const num = value === "" ? "" : Number(value);
      return {
        ...prev,
        billingOverrides: {
          ...(prev.billingOverrides || {}),
          allowances: {
            ...(
              (prev.billingOverrides && prev.billingOverrides.allowances) ||
              {}
            ),
            [code]: value === "" ? undefined : isNaN(num) ? 0 : num,
          },
        },
      };
    });
  }

  function updateOrgOverrideTaxRate(value) {
    setBillingOrgConfig((prev) => {
      if (!prev) return prev;
      const num = value === "" ? "" : Number(value);
      return {
        ...prev,
        billingOverrides: {
          ...(prev.billingOverrides || {}),
          taxRate: value === "" ? undefined : isNaN(num) ? 0 : num,
        },
      };
    });
  }

  async function saveOrgBilling() {
    if (!billingOrgConfig) return;
    setSavingOrgBilling(true);
    setErr("");
    setInfo("");
    try {
      const payload = {
        status: billingOrgConfig.status,
        plan: billingOrgConfig.plan,
        planCode: billingOrgConfig.planCode,
        currency: billingOrgConfig.currency,
        seats: billingOrgConfig.seats,
        billingOverrides: billingOrgConfig.billingOverrides || {},
      };
      await api.put(
        `/admin/super/orgs/${billingOrgConfig.orgId}/billing`,
        payload
      );
      setInfo("Organisation billing updated.");
      await load();
    } catch (e) {
      console.error("saveOrgBilling error:", e);
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setSavingOrgBilling(false);
    }
  }

  /* ---------------- Per-org billing preview handlers ---------------- */

  async function fetchBillingPreview(orgId, month) {
    if (!orgId) return;
    setBillingPreviewLoading(true);
    setErr("");
    setInfo("");
    try {
      const qs =
        month && month.trim()
          ? `?month=${encodeURIComponent(month.trim())}`
          : "";
      const { data } = await api.get(
        `/admin/super/orgs/${orgId}/billing-preview${qs}`
      );
      setBillingPreview(data || null);
    } catch (e) {
      console.error("fetchBillingPreview error:", e);
      setErr(e?.response?.data?.error || String(e));
      setBillingPreview(null);
    } finally {
      setBillingPreviewLoading(false);
    }
  }

  async function openBillingPreview(o) {
    if (!o || !o._id) return;
    setBillingPreviewOrg(o);
    setBillingPreview(null);
    setBillingPreviewMonth("");
    await fetchBillingPreview(o._id, "");
  }

  function closeBillingPreview() {
    setBillingPreviewOrg(null);
    setBillingPreview(null);
    setBillingPreviewMonth("");
  }

  /* ---------------- Plan-level pricing handlers ---------------- */

  const planSummaries = useMemo(() => {
    return (plans || []).map((p) => {
      const rateCount = p.rates ? Object.keys(p.rates).length : 0;
      const allowanceCount = p.allowances
        ? Object.keys(p.allowances).length
        : 0;
      return { ...p, rateCount, allowanceCount };
    });
  }, [plans]);

  async function openPlanPricing(planCode) {
    if (!planCode) return;
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get(
        `/admin/super/billing-plans/${encodeURIComponent(planCode)}`
      );
      setPlanModal({
        ...data,
        rates: data.rates || {},
        allowances: data.allowances || {},
      });
    } catch (e) {
      console.error("openPlanPricing error:", e);
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function closePlanModal() {
    setPlanModal(null);
  }

  function updatePlanField(field, value) {
    setPlanModal((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  function updatePlanRate(code, value) {
    setPlanModal((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        rates: {
          ...(prev.rates || {}),
          [code]: value,
        },
      };
    });
  }

  function updatePlanAllowance(code, value) {
    setPlanModal((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        allowances: {
          ...(prev.allowances || {}),
          [code]: value,
        },
      };
    });
  }

  async function savePlanPricing() {
    if (!planModal?.planCode) return;
    setSavingPlan(true);
    setErr("");
    setInfo("");
    try {
      const cleanRates = {};
      Object.entries(planModal.rates || {}).forEach(([k, v]) => {
        if (v === "" || v == null) return;
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        cleanRates[k] = num;
      });

      const cleanAllowances = {};
      Object.entries(planModal.allowances || {}).forEach(([k, v]) => {
        if (v === "" || v == null) return;
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        cleanAllowances[k] = num;
      });

      // Clean numeric top-level fields
      const cleanNumber = (raw) => {
        if (raw === "" || raw == null) return undefined;
        if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
        const num = Number(raw);
        return Number.isFinite(num) ? num : undefined;
      };

      const payload = {
        rates: cleanRates,
        allowances: cleanAllowances,
        taxRate: cleanNumber(planModal.taxRate),
        currency: planModal.currency || undefined,
        basePrice: cleanNumber(planModal.basePrice),
        includedSeats: cleanNumber(planModal.includedSeats),
        extraSeatPrice: cleanNumber(planModal.extraSeatPrice),
      };

      const { data } = await api.put(
        `/admin/super/billing-plans/${encodeURIComponent(
          planModal.planCode
        )}`,
        payload
      );

      setPlanModal({
        ...data,
        rates: data.rates || {},
        allowances: data.allowances || {},
      });

      // Refresh list
      const plansRes = await api.get("/admin/super/billing-plans");
      setPlans(Array.isArray(plansRes.data) ? plansRes.data : []);
      setInfo(`Plan "${planModal.planCode}" pricing saved.`);
    } catch (e) {
      console.error("savePlanPricing error:", e);
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setSavingPlan(false);
    }
  }

  /* ----------------------------- Render ----------------------------- */

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Global Admin Cockpit</h1>
        </div>
        <button
          className="btn btn-sm"
          onClick={load}
          disabled={loading}
          title="Reload stats"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Alerts */}
      <div className="space-y-1">
        <div className="px-3 py-2 rounded-lg bg-amber-50 text-amber-800 text-sm border border-amber-200">
          ⚠️ Be careful: You are operating at <strong>global</strong> scope.
          Changes here affect <span className="font-semibold">all organisations</span>.
        </div>
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
      </div>

      {/* Overview cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="p-4 rounded-2xl border bg-white shadow-sm">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Total organisations
          </div>
          <div className="mt-2 text-3xl font-bold">
            {overview?.totalOrgs ?? "—"}
          </div>
        </div>
        <div className="p-4 rounded-2xl border bg-white shadow-sm">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Active / Trialing orgs
          </div>
          <div className="mt-2 text-3xl font-bold">
            {overview?.activeOrgs ?? "—"}
          </div>
        </div>
        <div className="p-4 rounded-2xl border bg-white shadow-sm">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Global superadmins
          </div>
          <div className="mt-2 text-3xl font-bold">{totalGlobalSupers}</div>
        </div>
      </div>

      {/* Orgs + Users columns */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Orgs card */}
        <div className="p-4 rounded-2xl border bg-white shadow-sm flex flex-col min-h-[260px]">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold m-0">Organisations</h2>
            <input
              className="input input-bordered input-sm"
              placeholder="Search orgs…"
              value={orgSearch}
              onChange={(e) => setOrgSearch(e.target.value)}
              style={{ minWidth: 160 }}
            />
          </div>
          <div className="overflow-auto -mx-2 px-2">
            <table className="table w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Plan / Seats</th>
                  <th>Owner</th>
                  <th>Created</th>
                  <th>Last Active</th>
                  {/* 🔹 New money-ish column */}
                  <th>Revenue</th>
                  <th className="text-right">Billing</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrgs.length ? (
                  filteredOrgs.map((o) => {
                    const hasMrr = typeof o.mrr === "number";
                    const hasLastBill =
                      typeof o.lastBillTotal === "number" && o.lastBillMonth;
                    const hasLastInvoice = !!o.lastInvoiceAt;
                    const hasMoneyInfo = hasMrr || hasLastBill || hasLastInvoice;
                    const currency = o.currency || "ZAR";

                    return (
                      <tr key={o._id || o.id}>
                        <td className="align-top">
                          {o.name || <span className="text-gray-400">—</span>}
                        </td>
                        <td className="align-top">
                          <Pill tone={statusTone(o.status)}>
                            {o.status || "—"}
                          </Pill>
                        </td>
                        <td className="align-top">
                          <div className="flex flex-col">
                            <span>{o.plan || "—"}</span>
                            {typeof o.seats === "number" && (
                              <span className="text-xs text-gray-500">
                                {o.seats} seat{o.seats === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="align-top text-xs">
                          {o.ownerEmail || (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="align-top text-xs">
                          {fmtDate(o.createdAt)}
                        </td>
                        <td className="align-top text-xs">
                          {fmtDateTime(o.lastActiveAt)}
                        </td>
                        {/* 🔹 Revenue cell */}
                        <td className="align-top text-xs">
                          {hasMoneyInfo ? (
                            <div className="flex flex-col gap-0.5">
                              {hasMrr && (
                                <div>
                                  {currency}{" "}
                                  {o.mrr.toLocaleString(undefined, {
                                    maximumFractionDigits: 0,
                                  })}
                                  <span className="text-[10px] text-gray-500">
                                    {" "}
                                    / mo
                                  </span>
                                </div>
                              )}
                              {hasLastBill && (
                                <div className="text-[11px] text-gray-500">
                                  Last bill ({o.lastBillMonth}): {currency}{" "}
                                  {o.lastBillTotal.toLocaleString(undefined, {
                                    maximumFractionDigits: 0,
                                  })}
                                </div>
                              )}
                              {hasLastInvoice && (
                                <div className="text-[11px] text-gray-400">
                                  Last invoice: {fmtDate(o.lastInvoiceAt)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="align-top text-right">
                          <div className="flex flex-col items-end gap-1">
                            <button
                              className="btn btn-xs"
                              onClick={() => openOrgBilling(o)}
                            >
                              Configure
                            </button>
                            <button
                              className="btn btn-xs btn-outline"
                              onClick={() => openBillingPreview(o)}
                            >
                              Preview bill
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td
                      colSpan={8}
                      className="p-3 text-center text-gray-500 text-sm"
                    >
                      No organisations found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Users card */}
        <div className="p-4 rounded-2xl border bg-white shadow-sm flex flex-col min-h-[260px]">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold m-0">Users (global view)</h2>
            <input
              className="input input-bordered input-sm"
              placeholder="Search users…"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              style={{ minWidth: 160 }}
            />
          </div>
          <div className="overflow-auto -mx-2 px-2">
            <table className="table w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>OrgId</th>
                  <th>Role</th>
                  <th>Global</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length ? (
                  filteredUsers.map((u) => (
                    <tr key={u._id}>
                      <td className="align-top">{u.name || "—"}</td>
                      <td className="align-top text-xs">
                        {u.email || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="align-top text-xs">
                        {u.orgId ? (
                          idStr(u.orgId)
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="align-top">
                        <Pill tone={u.role === "superadmin" ? "ok" : "default"}>
                          {u.role || "—"}
                        </Pill>
                      </td>
                      <td className="align-top">
                        {u.isGlobalSuperadmin ? (
                          <Pill tone="ok">superadmin</Pill>
                        ) : (
                          <Pill tone="default">—</Pill>
                        )}
                      </td>
                      <td className="align-top text-right">
                        <button
                          className="btn btn-xs"
                          onClick={() => toggleGlobalSuper(u)}
                        >
                          {u.isGlobalSuperadmin ? "Remove global" : "Make global"}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={6}
                      className="p-3 text-center text-gray-500 text-sm"
                    >
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Global superadmins can access this cockpit regardless of org
            membership.
          </div>
        </div>
      </div>

      {/* Global billing defaults */}
      <div className="p-4 rounded-2xl border bg-white shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold m-0">
              Billing defaults (all orgs)
            </h2>
            <p className="text-xs text-gray-500">
              Adjust default per-event rates, free allowances, and tax. Per-org
              and per-plan overrides are applied on top.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 flex items-center gap-1">
              Currency
              <input
                className="input input-bordered input-xs w-24"
                value={billingDefaults?.currency || ""}
                onChange={(e) => changeDefaultCurrency(e.target.value)}
              />
            </label>
            <label className="text-xs text-gray-600 flex items-center gap-1">
              Tax rate
              <input
                className="input input-bordered input-xs w-24"
                type="number"
                step="0.01"
                value={
                  typeof billingDefaults?.taxRate === "number" ||
                  billingDefaults?.taxRate === ""
                    ? billingDefaults.taxRate
                    : ""
                }
                onChange={(e) => changeDefaultTaxRate(e.target.value)}
              />
            </label>
            <button
              className="btn btn-xs"
              onClick={saveBillingDefaults}
              disabled={savingDefaults}
            >
              {savingDefaults ? "Saving…" : "Save defaults"}
            </button>
          </div>
        </div>

        <div className="overflow-auto -mx-2 px-2 max-h-[260px]">
          <table className="table w-full text-xs">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th>Code</th>
                <th>Unit price</th>
                <th>Free per month</th>
              </tr>
            </thead>
            <tbody>
              {billingDefaults && billingKeys.length ? (
                billingKeys.map((code) => (
                  <tr key={code}>
                    <td className="align-center font-mono text-[14px]">
                      {code}
                    </td>
                    <td className="align-top">
                      <input
                        className="input input-bordered input-xs w-28"
                        type="number"
                        step="0.001"
                        value={
                          billingDefaults.rates?.[code] === "" ||
                          typeof billingDefaults.rates?.[code] === "number"
                            ? billingDefaults.rates[code]
                            : ""
                        }
                        onChange={(e) =>
                          changeDefaultRate(code, e.target.value)
                        }
                      />
                    </td>
                    <td className="align-top">
                      <input
                        className="input input-bordered input-xs w-28"
                        type="number"
                        step="1"
                        value={
                          billingDefaults.allowances?.[code] === "" ||
                          typeof billingDefaults.allowances?.[code] === "number"
                            ? billingDefaults.allowances[code]
                            : ""
                        }
                        onChange={(e) =>
                          changeDefaultAllowance(code, e.target.value)
                        }
                      />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={3}
                    className="p-3 text-center text-gray-500 text-xs"
                  >
                    No billing defaults loaded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Billing plans */}
      <div className="p-4 rounded-2xl border bg-white shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold m-0">Billing plans</h2>
            <p className="text-xs text-gray-500">
              Each plan has a fixed base price + included seats, plus its own
              per-event pricing. Organisations inherit their plan, then apply
              org-specific overrides on top.
            </p>
          </div>
        </div>

        <div className="overflow-auto -mx-2 px-2 max-h-[260px]">
          <table className="table w-full text-xs">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th>Plan code</th>
                <th>Currency</th>
                <th>Base / mo</th>
                <th>Included seats</th>
                <th>Extra seat price</th>
                <th>Tax rate</th>
                <th># Rates</th>
                <th># Allowances</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {planSummaries.length ? (
                planSummaries.map((p) => (
                  <tr key={p.planCode}>
                    <td className="align-top font-mono text-[14px]">
                      {p.planCode}
                    </td>
                    <td className="align-top">{p.currency || "—"}</td>
                    <td className="align-top">
                      {typeof p.basePrice === "number" ? p.basePrice : "—"}
                    </td>
                    <td className="align-top">
                      {typeof p.includedSeats === "number"
                        ? p.includedSeats
                        : "—"}
                    </td>
                    <td className="align-top">
                      {typeof p.extraSeatPrice === "number"
                        ? p.extraSeatPrice
                        : "—"}
                    </td>
                    <td className="align-top">
                      {typeof p.taxRate === "number" ? p.taxRate : "—"}
                    </td>
                    <td className="align-top">{p.rateCount}</td>
                    <td className="align-top">{p.allowanceCount}</td>
                    <td className="align-top text-right">
                      <button
                        className="btn btn-xs"
                        onClick={() => openPlanPricing(p.planCode)}
                      >
                        Configure
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={9}
                    className="p-3 text-center text-gray-500 text-xs"
                  >
                    No plans loaded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-org billing modal (lightbox) */}
      {billingOrgConfig && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          {/* click backdrop to close */}
          <div
            className="absolute inset-0"
            onClick={closeOrgBilling}
            aria-hidden="true"
          />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b">
              <div>
                <h2 className="text-lg font-semibold m-0">
                  Billing overrides • {billingOrgConfig.name || "Org"}
                </h2>
                <p className="text-xs text-gray-500">
                  Override plan, seats, currency, and specific rate/allowance
                  for this organisation.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-xs"
                  onClick={closeOrgBilling}
                  type="button"
                >
                  Close
                </button>
                <button
                  className="btn btn-xs btn-primary"
                  onClick={saveOrgBilling}
                  disabled={savingOrgBilling}
                >
                  {savingOrgBilling ? "Saving…" : "Save org billing"}
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div className="px-4 py-3 space-y-3 overflow-auto">
              <div className="grid gap-3 md:grid-cols-4 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Status</span>
                  <select
                    className="select select-bordered select-sm"
                    value={billingOrgConfig.status || ""}
                    onChange={(e) =>
                      updateOrgBillingField("status", e.target.value)
                    }
                  >
                    <option value="trialing">trialing</option>
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Plan label</span>
                  <input
                    className="input input-bordered input-sm"
                    value={billingOrgConfig.plan || ""}
                    onChange={(e) =>
                      updateOrgBillingField("plan", e.target.value)
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Plan code</span>
                  <input
                    className="input input-bordered input-sm"
                    value={billingOrgConfig.planCode || ""}
                    onChange={(e) =>
                      updateOrgBillingField("planCode", e.target.value)
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Seats</span>
                  <input
                    className="input input-bordered input-sm"
                    type="number"
                    min={0}
                    value={
                      typeof billingOrgConfig.seats === "number"
                        ? billingOrgConfig.seats
                        : ""
                    }
                    onChange={(e) =>
                      updateOrgBillingField(
                        "seats",
                        e.target.value === ""
                          ? 0
                          : Number(e.target.value) || 0
                      )
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Currency</span>
                  <input
                    className="input input-bordered input-sm"
                    value={billingOrgConfig.currency || ""}
                    onChange={(e) =>
                      updateOrgBillingField("currency", e.target.value)
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">
                    Tax rate override
                  </span>
                  <input
                    className="input input-bordered input-sm"
                    type="number"
                    step="0.01"
                    value={
                      typeof billingOrgConfig.billingOverrides?.taxRate ===
                        "number" ||
                      billingOrgConfig.billingOverrides?.taxRate === ""
                        ? billingOrgConfig.billingOverrides.taxRate
                        : ""
                    }
                    onChange={(e) => updateOrgOverrideTaxRate(e.target.value)}
                  />
                </label>
              </div>

              <div className="mt-1 text-xs text-gray-500">
                Leave override fields blank to fall back to global or plan
                defaults.
              </div>

              <div className="overflow-auto -mx-2 px-2 max-h-[260px]">
                <table className="table w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      <th>Code</th>
                      <th>Override unit price</th>
                      <th>Override free per month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billingDefaults && billingKeys.length ? (
                      billingKeys.map((code) => (
                        <tr key={code}>
                          <td className="align-top font-mono text-[11px]">
                            {code}
                          </td>
                          <td className="align-top">
                            <input
                              className="input input-bordered input-xs w-28"
                              type="number"
                              step="0.001"
                              placeholder={String(
                                billingDefaults.rates?.[code] ?? ""
                              )}
                              value={
                                typeof billingOrgConfig.billingOverrides
                                  ?.rates?.[code] === "number" ||
                                billingOrgConfig.billingOverrides?.rates?.[
                                  code
                                ] === ""
                                  ? billingOrgConfig.billingOverrides.rates[
                                      code
                                    ]
                                  : ""
                              }
                              onChange={(e) =>
                                updateOrgOverrideRate(code, e.target.value)
                              }
                            />
                          </td>
                          <td className="align-top">
                            <input
                              className="input input-bordered input-xs w-28"
                              type="number"
                              step="1"
                              placeholder={String(
                                billingDefaults.allowances?.[code] ?? ""
                              )}
                              value={
                                typeof billingOrgConfig.billingOverrides
                                  ?.allowances?.[code] === "number" ||
                                billingOrgConfig.billingOverrides
                                  ?.allowances?.[code] === ""
                                  ? billingOrgConfig.billingOverrides
                                      .allowances[code]
                                  : ""
                              }
                              onChange={(e) =>
                                updateOrgOverrideAllowance(
                                  code,
                                  e.target.value
                                )
                              }
                            />
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={3}
                          className="p-3 text-center text-gray-500 text-xs"
                        >
                          No billing codes available.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plan pricing modal (lightbox) */}
      {planModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          {/* backdrop */}
          <div
            className="absolute inset-0"
            onClick={closePlanModal}
            aria-hidden="true"
          />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b">
              <div>
                <h2 className="text-lg font-semibold m-0">
                  Plan pricing • {planModal.planCode}
                </h2>
                <p className="text-xs text-gray-500">
                  Base price + included seats define the fixed monthly fee.
                  Per-event pricing then applies once free allowances are
                  exceeded.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-xs"
                  onClick={closePlanModal}
                  type="button"
                >
                  Close
                </button>
                <button
                  className="btn btn-xs btn-primary"
                  onClick={savePlanPricing}
                  disabled={savingPlan}
                >
                  {savingPlan ? "Saving…" : "Save plan pricing"}
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div className="px-4 py-3 space-y-3 overflow-auto">
              <div className="grid gap-3 md:grid-cols-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Currency</span>
                  <input
                    className="input input-bordered input-sm"
                    value={planModal.currency || ""}
                    onChange={(e) =>
                      updatePlanField("currency", e.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Tax rate</span>
                  <input
                    className="input input-bordered input-sm"
                    type="number"
                    step="0.01"
                    value={planModal.taxRate ?? ""}
                    onChange={(e) =>
                      updatePlanField("taxRate", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-3 text-sm mt-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">Base price / mo</span>
                  <input
                    className="input input-bordered input-sm"
                    type="number"
                    step="0.01"
                    value={planModal.basePrice ?? ""}
                    onChange={(e) =>
                      updatePlanField("basePrice", e.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">
                    Included seats
                  </span>
                  <input
                    className="input input-bordered input-sm"
                    type="number"
                    step="1"
                    value={planModal.includedSeats ?? ""}
                    onChange={(e) =>
                      updatePlanField("includedSeats", e.target.value)
                    }
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-600">
                    Extra seat price
                  </span>
                  <input
                    className="input input-bordered input-sm"
                    type="number"
                    step="0.01"
                    value={planModal.extraSeatPrice ?? ""}
                    onChange={(e) =>
                      updatePlanField("extraSeatPrice", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="overflow-auto -mx-2 px-2 max-h-[260px] mt-3">
                <table className="table w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      <th>Code</th>
                      <th>Unit price</th>
                      <th>Free per month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billingDefaults && billingKeys.length ? (
                      billingKeys.map((code) => (
                        <tr key={code}>
                          <td className="align-top font-mono text-[11px]">
                            {code}
                          </td>
                          <td className="align-top">
                            <input
                              className="input input-bordered input-xs w-28"
                              type="number"
                              step="0.001"
                              value={planModal.rates?.[code] ?? ""}
                              onChange={(e) =>
                                updatePlanRate(code, e.target.value)
                              }
                            />
                          </td>
                          <td className="align-top">
                            <input
                              className="input input-bordered input-xs w-28"
                              type="number"
                              step="1"
                              value={planModal.allowances?.[code] ?? ""}
                              onChange={(e) =>
                                updatePlanAllowance(code, e.target.value)
                              }
                            />
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={3}
                          className="p-3 text-center text-gray-500 text-xs"
                        >
                          No billing codes available.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-1 text-xs text-gray-500">
                Leave any code blank to omit it from this plan; it will fall
                back to global defaults until you explicitly set it here.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-org billing preview modal */}
      {billingPreviewOrg && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <div
            className="absolute inset-0"
            onClick={closeBillingPreview}
            aria-hidden="true"
          />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b">
              <div>
                <h2 className="text-lg font-semibold m-0">
                  Billing preview • {billingPreviewOrg.name || "Org"}
                </h2>
                <p className="text-xs text-gray-500">
                  This is a read-only preview based on recorded usage and the
                  current pricing configuration.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-xs"
                  type="button"
                  onClick={closeBillingPreview}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-4 py-3 space-y-3 overflow-auto text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1 text-xs text-gray-600">
                  Month (YYYY-MM)
                  <input
                    className="input input-bordered input-xs w-28"
                    placeholder="e.g. 2025-03"
                    value={billingPreviewMonth}
                    onChange={(e) => setBillingPreviewMonth(e.target.value)}
                  />
                </label>
                <button
                  className="btn btn-xs"
                  onClick={() =>
                    fetchBillingPreview(
                      billingPreviewOrg._id,
                      billingPreviewMonth
                    )
                  }
                  disabled={billingPreviewLoading}
                >
                  {billingPreviewLoading ? "Loading…" : "Load month"}
                </button>
              </div>

              {billingPreview ? (
                <>
                  <div className="grid gap-3 md:grid-cols-2 text-xs mt-2">
                    <div className="space-y-1">
                      <div>
                        <span className="font-semibold">Plan:</span>{" "}
                        {billingPreview.plan || "—"} (
                        <span className="font-mono">
                          {billingPreview.planCode || "—"}
                        </span>
                        )
                      </div>
                      <div>
                        <span className="font-semibold">Seats:</span>{" "}
                        {typeof billingPreview.seats === "number"
                          ? billingPreview.seats
                          : "—"}
                      </div>
                      <div>
                        <span className="font-semibold">Month:</span>{" "}
                        {billingPreview.month || "—"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div>
                        <span className="font-semibold">Currency:</span>{" "}
                        {billingPreview.currency || "USD"}
                      </div>
                      <div>
                        <span className="font-semibold">Tax rate:</span>{" "}
                        {typeof billingPreview.pricing?.taxRate === "number"
                          ? billingPreview.pricing.taxRate
                          : "—"}
                      </div>
                      <div>
                        <span className="font-semibold">Base price / mo:</span>{" "}
                        {typeof billingPreview.pricing?.basePrice === "number"
                          ? billingPreview.pricing.basePrice
                          : "—"}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-auto -mx-2 px-2 max-h-[260px] mt-3">
                    <table className="table w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0 z-10">
                        <tr>
                          <th>Code</th>
                          <th>Count</th>
                          <th>Free</th>
                          <th>Billable</th>
                          <th>Unit price</th>
                          <th>Subtotal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {billingPreview.preview?.lines?.length ? (
                          billingPreview.preview.lines.map((line, idx) => (
                            <tr key={`${line.code || "line"}-${idx}`}>
                              <td className="align-top font-mono text-[11px]">
                                {line.code}
                              </td>
                              <td className="align-top">{line.count}</td>
                              <td className="align-top">{line.free}</td>
                              <td className="align-top">{line.billable}</td>
                              <td className="align-top">
                                {typeof line.unitPrice === "number"
                                  ? line.unitPrice.toFixed(3)
                                  : line.unitPrice ?? "0"}
                              </td>
                              <td className="align-top">
                                {typeof line.subtotal === "number"
                                  ? line.subtotal.toFixed(2)
                                  : line.subtotal ?? "0"}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td
                              colSpan={6}
                              className="p-3 text-center text-gray-500 text-xs"
                            >
                              No billing lines for this period.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 flex flex-col items-end text-xs gap-1">
                    <div>
                      <span className="font-semibold mr-2">Subtotal:</span>
                      {typeof billingPreview.preview?.subtotal === "number"
                        ? billingPreview.preview.subtotal.toFixed(2)
                        : "0.00"}
                    </div>
                    <div>
                      <span className="font-semibold mr-2">Tax:</span>
                      {typeof billingPreview.preview?.tax === "number"
                        ? billingPreview.preview.tax.toFixed(2)
                        : "0.00"}
                    </div>
                    <div className="text-sm font-semibold">
                      <span className="mr-2">Total:</span>
                      {typeof billingPreview.preview?.total === "number"
                        ? billingPreview.preview.total.toFixed(2)
                        : "0.00"}
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-3 text-xs text-gray-500">
                  {billingPreviewLoading
                    ? "Loading billing preview…"
                    : "No preview loaded yet for this organisation."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
