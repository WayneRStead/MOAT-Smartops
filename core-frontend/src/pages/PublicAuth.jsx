// src/pages/PublicAuth.jsx
import React from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../lib/api";

/* ----------------------------- small helpers ----------------------------- */
function clearOrgCaches() {
  try {
    // clear any cached org blob/theme so old logo/colors don't flash
    localStorage.removeItem("org");
    sessionStorage.removeItem("org");
    // optional: clear any local inspection mocks you might have used
    localStorage.removeItem("mock:inspections:forms");
    localStorage.removeItem("mock:inspections:subms");
  } catch {}
}

function saveToken(token) {
  if (!token) return;
  try {
    localStorage.setItem("token", token);
  } catch {}
}

function saveOrgId(orgId) {
  if (!orgId) return;
  try {
    localStorage.setItem("orgId", orgId);
    // some folks also store tenantId; harmless to mirror
    localStorage.setItem("tenantId", orgId);
  } catch {}
}

function saveTokenAndOrg({ token, orgId }) {
  saveToken(token);
  saveOrgId(orgId);
}

function parseOrgsFromLogin(data) {
  // Expected patterns from backend:
  //  A) { token, orgId }
  //  B) { token, orgs: [{ orgId, name }, ...] }
  //  C) { token, user: { orgs: [...] } }
  const orgId = data?.orgId || data?.tenantId || null;
  const list =
    data?.orgs ||
    data?.organizations ||
    data?.user?.orgs ||
    data?.user?.organizations ||
    [];
  return { orgId, list: Array.isArray(list) ? list : [] };
}

/** Fallback discovery: ask backend which orgs this token can access. */
async function fetchMembershipsViaWhoAmI() {
  try {
    const { data } = await api.get("/public/whoami", { _maxRetries: 1 });
    // normalize memberships array -> [{ id, name }]
    const raw =
      data?.memberships ||
      data?.orgs ||
      data?.organizations ||
      data?.user?.orgs ||
      [];
    const items = Array.isArray(raw) ? raw : [];
    return items.map((o) => ({
      id: String(o.orgId || o.id),
      name: o.name || o.slug || String(o.orgId || o.id),
    }));
  } catch {
    return [];
  }
}

/* ------------------------------- component ------------------------------- */
export default function PublicAuth() {
  const nav = useNavigate();

  const [mode, setMode] = React.useState("signin"); // "signin" | "signup"
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");

  // Common fields
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  // Signup-only
  const [orgName, setOrgName] = React.useState("");
  const [name, setName] = React.useState("");

  // Multiple orgs picker
  const [orgChoices, setOrgChoices] = React.useState([]); // [{id,name}]
  const [pickedOrgId, setPickedOrgId] = React.useState("");

  /* ---------------------------- core flows ---------------------------- */

  async function completeLoginFlow({ token, orgIdFromResp, orgListFromResp }) {
    // Always store token right away
    saveToken(token);

    // First try the orgId that came with the response
    if (orgIdFromResp) {
      clearOrgCaches();
      saveOrgId(orgIdFromResp);
      // Redirect + hard reload once to ensure X-Org-Id header is present from the first load
      nav("/projects-dashboard", { replace: true });
      setTimeout(() => window.location.reload(), 0);
      return;
    }

    // If backend returned a list, handle 1 or many
    if (Array.isArray(orgListFromResp) && orgListFromResp.length > 0) {
      if (orgListFromResp.length === 1) {
        const single = orgListFromResp[0];
        const oid = String(single.orgId || single.id);
        clearOrgCaches();
        saveOrgId(oid);
        nav("/projects-dashboard", { replace: true });
        setTimeout(() => window.location.reload(), 0);
        return;
      }
      // Multiple: show picker
      setOrgChoices(
        orgListFromResp.map((o) => ({
          id: String(o.orgId || o.id),
          name: o.name || o.slug || String(o.orgId || o.id),
        }))
      );
      setPickedOrgId("");
      return;
    }

    // Otherwise, call whoami to discover memberships
    const memberships = await fetchMembershipsViaWhoAmI();
    if (memberships.length === 1) {
      clearOrgCaches();
      saveOrgId(memberships[0].id);
      nav("/projects-dashboard", { replace: true });
      setTimeout(() => window.location.reload(), 0);
      return;
    }
    if (memberships.length > 1) {
      setOrgChoices(memberships);
      setPickedOrgId("");
      return;
    }

    // No orgs: guide to Signup
    setMode("signup");
    setErr("No organization found for this account. Create one below.");
  }

  async function handleSignin(e) {
    e?.preventDefault?.();
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.post("/public/login", { email, password });
      const token = data?.token;
      if (!token) throw new Error("No token returned");

      const { orgId, list } = parseOrgsFromLogin(data);
      await completeLoginFlow({
        token,
        orgIdFromResp: orgId,
        orgListFromResp: list,
      });
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup(e) {
    e?.preventDefault?.();
    setErr("");
    setLoading(true);
    try {
      const payload = { orgName, name, email, password };
      const { data } = await api.post("/public/signup", payload);
      const token = data?.token;
      const oid = data?.orgId || data?.tenantId || null;

      if (!token) throw new Error("Signup did not return a token");
      // Complete the flow exactly like login (handles with/without orgId)
      await completeLoginFlow({
        token,
        orgIdFromResp: oid,
        orgListFromResp: null,
      });
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  function handlePickOrg(e) {
    e?.preventDefault?.();
    setErr("");
    if (!pickedOrgId) {
      setErr("Please select an organisation.");
      return;
    }
    const token = localStorage.getItem("token") || "";
    if (!token) {
      setErr("Session expired. Please sign in again.");
      setOrgChoices([]);
      setPickedOrgId("");
      setMode("signin");
      return;
    }
    clearOrgCaches();
    saveOrgId(pickedOrgId);
    nav("/projects-dashboard", { replace: true });
    setTimeout(() => window.location.reload(), 0);
  }

  /* ------------------------------- UI ------------------------------- */

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "80dvh" }}>
      <div
        style={{
          width: "min(520px, 92vw)",
          background: "var(--panel, #fff)",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 12,
          padding: 16,
          boxShadow: "0 8px 24px rgba(0,0,0,.08)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          MOAT SmartOps
        </h1>
        <div className="muted" style={{ marginTop: 4 }}>
          {orgChoices.length > 0
            ? "Choose your organisation"
            : mode === "signin"
            ? "Sign in to your account"
            : "Create your organisation"}
        </div>

        {Boolean(err) && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              fontSize: 14,
            }}
          >
            {err}
          </div>
        )}

        {/* Org picker (when the user belongs to multiple orgs) */}
        {orgChoices.length > 0 ? (
          <form
            onSubmit={handlePickOrg}
            style={{ marginTop: 16, display: "grid", gap: 10 }}
          >
            <label style={{ fontWeight: 600 }}>Select organisation</label>
            <select
              value={pickedOrgId}
              onChange={(e) => setPickedOrgId(e.target.value)}
            >
              <option value="">— choose one —</option>
              {orgChoices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button className="btn-primary" disabled={!pickedOrgId || loading}>
              Continue
            </button>
          </form>
        ) : mode === "signin" ? (
          <form
            onSubmit={handleSignin}
            style={{ marginTop: 16, display: "grid", gap: 10 }}
          >
            <label>
              <div style={{ fontWeight: 600 }}>Email</div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              <div style={{ fontWeight: 600 }}>Password</div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>

            {/* 👉 Forgot password link under the password field */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 4,
                fontSize: 13,
              }}
            >
              <Link
                to="/forgot-password"
                style={{ color: "#2563eb", textDecoration: "none" }}
                onMouseOver={(e) => (e.currentTarget.style.textDecoration = "underline")}
                onMouseOut={(e) =>
                  (e.currentTarget.style.textDecoration = "none")
                }
              >
                Forgot your password?
              </Link>
            </div>

            <button className="btn-primary" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
            <div style={{ marginTop: 8 }}>
              <span className="muted">Not yet signed up? </span>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode("signup");
                  setErr("");
                }}
              >
                Create an organisation
              </a>
            </div>
          </form>
        ) : (
          <form
            onSubmit={handleSignup}
            style={{ marginTop: 16, display: "grid", gap: 10 }}
          >
            <label>
              <div style={{ fontWeight: 600 }}>Organisation Name</div>
              <input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                required
              />
            </label>
            <label>
              <div style={{ fontWeight: 600 }}>Your Name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label>
              <div style={{ fontWeight: 600 }}>Email</div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              <div style={{ fontWeight: 600 }}>Password</div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="btn-primary" disabled={loading}>
              {loading ? "Creating…" : "Create organisation"}
            </button>
            <div style={{ marginTop: 8 }}>
              <span className="muted">Already have an account? </span>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode("signin");
                  setErr("");
                }}
              >
                Sign in
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
