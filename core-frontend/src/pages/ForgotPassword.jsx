// src/pages/ForgotPassword.jsx
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { requestPasswordReset } from "../services/auth";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setMessage("");
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setMessage(
        "If an account exists for this email, a reset link has been sent."
      );
    } catch (e) {
      const msg =
        e?.response?.data?.error ||
        e?.message ||
        "Unable to request reset at the moment.";
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto p-6 space-y-4">
      <h1 className="text-xl font-semibold">Forgot your password?</h1>
      <p className="text-sm text-gray-600">
        Enter your email address and we&apos;ll send you a link to reset your password.
      </p>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            className="border rounded px-3 py-2 w-full"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e)=>setEmail(e.target.value)}
          />
        </div>

        {err && <div className="text-red-600 text-sm">{err}</div>}
        {message && <div className="text-green-700 text-sm">{message}</div>}

        <button
          type="submit"
          className="bg-black text-white px-4 py-2 rounded w-full disabled:opacity-70"
          disabled={submitting || !email.trim()}
        >
          {submitting ? "Sending..." : "Send reset link"}
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
