// src/pages/Login.jsx
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { login } from "../services/auth";

export default function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@smartops");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

   async function onSubmit(e) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await login({ email, password });
      navigate("/projects-dashboard", { replace: true }); // or "/"
    } catch (e) {
      const msg = e?.response?.data?.error || "Login failed";
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-sm mx-auto p-6 space-y-4">
      <h1 className="text-xl font-semibold">Sign in</h1>

      <div className="space-y-1">
        <label className="block text-sm font-medium text-gray-700">
          Email
        </label>
        <input
          className="border rounded px-3 py-2 w-full"
          placeholder="you@example.com"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e)=>setEmail(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium text-gray-700">
          Password
        </label>
        <div className="flex items-center border rounded px-2">
          <input
            className="flex-1 px-1 py-2 outline-none"
            placeholder="••••••••"
            type={showPw ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e)=>setPassword(e.target.value)}
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

      {err && <div className="text-red-600 text-sm">{err}</div>}

      <div className="flex items-center justify-between text-sm">
        <Link
          to="/forgot-password"
          className="text-blue-600 hover:underline"
        >
          Forgot your password?
        </Link>
      </div>

      <button
        className="bg-black text-white px-4 py-2 rounded w-full disabled:opacity-70"
        disabled={loading}
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
