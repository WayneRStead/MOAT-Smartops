import React, { useState } from "react";
import { login } from "../services/auth";

export default function SignIn() {
  const [email, setEmail] = useState("admin@smartops");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(null); setLoading(true);
    try {
      await login({ email, password });
      window.location.href = "/"; // or navigate('/'), depending on your router
    } catch (e) {
      const msg = e?.response?.data?.error || "Login failed";
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-sm mx-auto p-6 space-y-3">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input
        className="border p-2 w-full"
        placeholder="email"
        value={email}
        onChange={(e)=>setEmail(e.target.value)}
      />
      <input
        className="border p-2 w-full"
        placeholder="password"
        type="password"
        value={password}
        onChange={(e)=>setPassword(e.target.value)}
      />
      {err && <div className="text-red-600 text-sm">{err}</div>}
      <button className="bg-black text-white px-4 py-2" disabled={loading}>
        {loading ? "..." : "Sign in"}
      </button>
    </form>
  );
}
