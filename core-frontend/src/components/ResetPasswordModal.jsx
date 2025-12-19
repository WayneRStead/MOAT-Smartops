// src/components/ResetPasswordModal.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

function Modal({ open, onClose, title, children, width = 520 }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[300] bg-black/50 grid place-items-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-h-[90vh] w-full"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold m-0">{title}</h3>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-4 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

const idStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v._id || v.id || v);
  return String(v);
};

export default function ResetPasswordModal({ user, onClose, onDone }) {
  const open = !!user;
  const userId = useMemo(() => idStr(user?.id || user?._id || user), [user]);
  const display = user?.name || user?.email || user?.username || userId || "";

  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPwd("");
      setPwd2("");
      setErr("");
      setInfo("");
      setBusy(false);
    }
  }, [open]);

  function gen() {
    // simple strong-ish temp generator
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
    let out = "";
    for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setPwd(out);
    setPwd2(out);
  }

  async function submit(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    if (!userId) {
      setErr("Missing user id.");
      return;
    }
    if (!pwd || pwd.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }
    if (pwd !== pwd2) {
      setErr("Passwords do not match.");
      return;
    }
    try {
      setBusy(true);
      await api.post(`/users/${userId}/reset-password`, { password: pwd });
      setInfo("Password reset successfully.");
      // Let parent refresh the list, then close
      onDone?.();
      onClose?.();
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reset Password">
      <form onSubmit={submit} className="space-y-3">
        <div className="text-sm text-gray-700">
          User: <strong>{display}</strong>
        </div>
        {err && <div className="text-sm text-red-600">{err}</div>}
        {info && <div className="text-sm text-green-700">{info}</div>}

        <label className="text-sm block">
          New password
          <input
            className="border p-2 w-full"
            type="text"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="At least 6 characters"
            autoFocus
          />
        </label>
        <label className="text-sm block">
          Confirm password
          <input
            className="border p-2 w-full"
            type="text"
            value={pwd2}
            onChange={(e) => setPwd2(e.target.value)}
            placeholder="Re-enter password"
          />
        </label>

        <div className="flex items-center justify-between pt-1">
          <button type="button" className="btn btn-sm" onClick={gen}>
            Generate strong temp
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className="px-3 py-2 border rounded" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="px-3 py-2 bg-black text-white rounded disabled:opacity-60" disabled={busy}>
              {busy ? "Saving…" : "Reset Password"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
