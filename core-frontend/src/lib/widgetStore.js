// src/lib/widgetsStore.js
const KEY = "org.dashboardWidgets";

export function loadWidgetsFromStorage() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
export function saveWidgetsToStorage(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr || [])); } catch {}
}
