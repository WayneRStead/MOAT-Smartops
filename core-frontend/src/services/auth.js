// src/services/auth.js
import { api } from "../lib/api";

// payload: { email?: string, username?: string, password: string }
export async function login(payload) {
  const { data } = await api.post("/auth/login", payload);
  localStorage.setItem("token", data.token);
  localStorage.setItem("user", JSON.stringify(data.user));
  return data.user;
}

export function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.href = "/login"; // adjust if your route is different
}

export function getUser() {
  try {
    const raw = localStorage.getItem("user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function whoAmI() {
  const { data } = await api.get("/auth/me");
  return data.user; // { sub, role, orgId? }
}
