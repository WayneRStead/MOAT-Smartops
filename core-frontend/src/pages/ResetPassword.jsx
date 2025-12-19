// src/pages/ResetPassword.jsx
import React, { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { resetPassword } from "../services/auth";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const initialToken = searchParams.get("token") || "";

  const [token, setToken] = useState(initialToken);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (initialToken && !token) setToken(initialToken);
  }, [initialToken, token]);

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setSuccess(false);

    if (!token) {
      setErr("Reset token is missing. Please use the link from your email.");
      return;
    }
    if (pw.length < 8) {
      setErr("Password must be at least 8 characters long.");
      return;
    }
    if (pw !== pw2) {
      setErr("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword({ token, password: pw });
      setSuccess(true);
      setPw("");
      setPw2("");
    } catch (e) {
      const msg =
        e?.response?.data?.error ||
        e?.message ||
        "Unable to reset password. The link may have expired.";
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto p-6 space-y-4">
      <h1 className="text-xl font-semibold">Reset your password</h1>

      <form onSubmit={onSubmit} className="space-y-3">
        {!initialToken && (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">
              Reset token
            </label>
            <input
              className="border rounded px-3 py-2 w-full"
              type="text"
              placeholder="Paste your reset token"
              value={token}
              onChange={(e)=>setToken(e.target.value)}
            />
          </div>
        )}

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700">
            New password
          </label>
          <div className="flex items-center border rounded px-2">
            <input
              className="flex-1 px-1 py-2 outline-none"
              type={showPw ? "text" : "password"}
              value={pw}
              onChange={(e)=>setPw(e.target.value)}
              placeholder="At least 8 characters"
            />
            <button
              type="button"
              onClick={()=>setShowPw(v => !v)}
              className="text-xs text-gray-600 px-2 py-1 hover:text-black"
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700">
            Confirm password
          </label>
          <input
            className="border rounded px-3 py-2 w-full"
            type={showPw ? "text" : "password"}
            value={pw2}
            onChange={(e)=>setPw2(e.target.value)}
            placeholder="Repeat your password"
          />
        </div>

        {err && <div className="text-red-600 text-sm">{err}</div>}
        {success && (
          <div className="text-green-700 text-sm">
            Password has been reset. You can now{" "}
            <Link to="/public/auth" className="underline">
              sign in
            </Link>
            .
          </div>
        )}

        <button
          type="submit"
          className="bg-black text-white px-4 py-2 rounded w-full disabled:opacity-70"
          disabled={submitting}
        >
          {submitting ? "Updating…" : "Reset password"}
        </button>
      </form>

      <div className="text-sm">
        <Link to="/public/auth" className="text-blue-600 hover:underline">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
