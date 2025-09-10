import React, { useState } from "react";
import { api } from "../lib/api";

export default function ResetPasswordModal({ user, onClose, onDone }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  if (!user) return null;

  async function submit(e) {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      await api.post("/auth/admin/reset-password", { userId: user.id || user._id, newPassword: pw });
      setShow(true);
      onDone?.();
    } catch (e) {
      setErr(e?.response?.data?.error || "Failed to reset password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white p-4 rounded shadow max-w-md w-full">
        <h2 className="text-lg font-semibold mb-3">Reset Password</h2>
        <div className="text-sm text-gray-600 mb-3">User: <strong>{user.name || user.email}</strong></div>

        {show ? (
          <div className="bg-green-50 border border-green-200 p-3 rounded mb-3">
            Password updated successfully.
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <input
              className="border p-2 w-full"
              placeholder="New password"
              type="password"
              value={pw}
              onChange={(e)=>setPw(e.target.value)}
            />
            {err && <div className="text-red-600 text-sm">{err}</div>}
            <div className="flex gap-2 justify-end">
              <button type="button" className="px-3 py-2 border rounded" onClick={onClose}>Cancel</button>
              <button className="px-3 py-2 bg-black text-white rounded" disabled={loading || !pw}>
                {loading ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        )}

        {show && (
          <div className="mt-2 text-right">
            <button className="px-3 py-2 border rounded" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
