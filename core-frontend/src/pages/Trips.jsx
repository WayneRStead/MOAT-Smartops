// src/pages/Trips.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const fmtDT = (v) => (v ? new Date(v).toLocaleString() : "—");
const asId = (x) =>
  typeof x === "string" || typeof x === "number"
    ? String(x)
    : x && (x._id || x.id || x.value || x.userId)
    ? String(x._id || x.id || x.value || x.userId)
    : "";

function Tag({ children }) {
  return <span className="px-2 py-0.5 rounded text-xs bg-gray-100">{children}</span>;
}

export default function Trips() {
  const [trips, setTrips] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const emptyForm = { vehicleId: "", driverId: "", notes: "" };
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null); // trip being edited inline

  // ---------- Loaders ----------
  async function loadTrips() {
    setErr("");
    try {
      const params = { limit: 200 };
      if (q) params.q = q;
      if (status) params.status = status;
      if (includeDeleted) params.includeDeleted = 1;

      let data = [];
      try {
        const r = await api.get("/vehicle-trips", { params });
        data = Array.isArray(r.data) ? r.data : [];
      } catch {
        const r = await api.get("/trips", { params });
        data = Array.isArray(r.data) ? r.data : [];
      }
      setTrips(data);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function loadVehicles() {
    try {
      const { data } = await api.get("/vehicles", { params: { limit: 500 } });
      setVehicles(Array.isArray(data) ? data : []);
    } catch {
      setVehicles([]);
    }
  }

  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 500 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      setUsers([]);
    }
  }

  useEffect(() => {
    loadTrips();
    loadVehicles();
    loadUsers();
    // eslint-disable-next-line
  }, [includeDeleted]);

  const vehicleName = (id) => {
    const v = vehicles.find((x) => String(x._id) === String(id) || String(x.id) === String(id));
    return v ? v.name || v.reg || v.registration || v.plate || v.title || String(id) : "—";
  };
  const userName = (id) => {
    const u = users.find((x) => String(x._id) === String(id));
    return u ? u.name || u.email || u.username : id ? String(id) : "—";
  };

  // ---------- Create ----------
  async function createTrip(e) {
    e.preventDefault();
    setErr("");
    setInfo("");
    try {
      const payload = {
        vehicleId: form.vehicleId || undefined,
        driverId: form.driverId || undefined,
        notes: (form.notes || "").trim() || undefined,
        status: "not_started",
      };
      let res;
      try {
        res = await api.post("/vehicle-trips", payload);
      } catch {
        res = await api.post("/trips", payload);
      }
      setInfo("Trip created.");
      setForm(emptyForm);
      setTrips((prev) => [res.data, ...prev]);
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  // ---------- Edit / Save (robust) ----------
  function beginEdit(t) {
    setEditing({
      _id: t._id,
      vehicleId: asId(t.vehicleId || t.vehicle),
      driverId: asId(t.driverId || t.driver),
      notes: t.notes || "",
      startedAt: t.startedAt || t.startAt || t.started || "",
      endedAt: t.endedAt || t.endAt || t.ended || "",
      startOdometer: t.startOdometer || t.odoStart || "",
      endOdometer: t.endOdometer || t.odoEnd || "",
      status: t.status || "",
    });
  }
  function cancelEdit() {
    setEditing(null);
  }

  async function robustTripSave(id, patch) {
    const attempts = [
      { m: "put", u: `/vehicle-trips/${id}`, b: patch },
      { m: "patch", u: `/vehicle-trips/${id}`, b: patch },
      { m: "put", u: `/trips/${id}`, b: patch },
      { m: "patch", u: `/trips/${id}`, b: patch },
    ];
    let lastErr;
    for (const a of attempts) {
      try {
        await api[a.m](a.u, a.b);
        let got;
        try {
          got = (await api.get(`/vehicle-trips/${id}`)).data;
        } catch {
          got = (await api.get(`/trips/${id}`)).data;
        }
        setTrips((prev) => prev.map((t) => (t._id === id ? got : t)));
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    setErr(lastErr?.response?.data?.error || "Failed to save trip.");
    return false;
  }

  async function saveEdit(e) {
    e.preventDefault();
    if (!editing?._id) return;
    setErr("");
    setInfo("");
    const id = editing._id;
    const patch = {
      vehicleId: editing.vehicleId || null,
      driverId: editing.driverId || null,
      notes: editing.notes || "",
      startOdometer: editing.startOdometer || undefined,
      endOdometer: editing.endOdometer || undefined,
      startedAt: editing.startedAt || undefined,
      endedAt: editing.endedAt || undefined,
      status: editing.status || undefined,
    };
    const ok = await robustTripSave(id, patch);
    if (ok) {
      setInfo("Trip updated.");
      setEditing(null);
    }
  }

  // ---------- Start / End ----------
  function getNowIso() {
    return new Date().toISOString();
  }

  function getGeo() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: Number(pos.coords.latitude.toFixed(6)),
            lng: Number(pos.coords.longitude.toFixed(6)),
            accuracy: pos.coords.accuracy,
          }),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
      );
    });
  }

  async function startTrip(t) {
    setErr("");
    setInfo("");
    const id = t._id;
    const ts = getNowIso();
    const where = await getGeo();

    const actionBodies = [
      { m: "patch", u: `/vehicle-trips/${id}/start`, b: { startedAt: ts, startLocation: where, status: "in_progress" } },
      { m: "post", u: `/vehicle-trips/${id}/start`, b: { startedAt: ts, startLocation: where, status: "in_progress" } },
      { m: "patch", u: `/trips/${id}/start`, b: { startedAt: ts, startLocation: where, status: "in_progress" } },
      { m: "post", u: `/trips/${id}/start`, b: { startedAt: ts, startLocation: where, status: "in_progress" } },
    ];

    let ok = false;
    for (const a of actionBodies) {
      try {
        await api[a.m](a.u, a.b);
        ok = true;
        break;
      } catch {}
    }

    if (!ok) ok = await robustTripSave(id, { startedAt: ts, startLocation: where || undefined, status: "in_progress" });

    if (ok) {
      try {
        const got = (await api.get(`/vehicle-trips/${id}`)).data;
        setTrips((prev) => prev.map((x) => (x._id === id ? got : x)));
      } catch {
        try {
          const got = (await api.get(`/trips/${id}`)).data;
          setTrips((prev) => prev.map((x) => (x._id === id ? got : x)));
        } catch {}
      }
      setInfo("Trip started.");
    }
  }

  async function endTrip(t) {
    setErr("");
    setInfo("");
    const id = t._id;
    const ts = getNowIso();
    const where = await getGeo();

    const actionBodies = [
      { m: "patch", u: `/vehicle-trips/${id}/end`, b: { endedAt: ts, endLocation: where, status: "ended" } },
      { m: "post", u: `/vehicle-trips/${id}/end`, b: { endedAt: ts, endLocation: where, status: "ended" } },
      { m: "patch", u: `/trips/${id}/end`, b: { endedAt: ts, endLocation: where, status: "ended" } },
      { m: "post", u: `/trips/${id}/end`, b: { endedAt: ts, endLocation: where, status: "ended" } },
    ];

    let ok = false;
    for (const a of actionBodies) {
      try {
        await api[a.m](a.u, a.b);
        ok = true;
        break;
      } catch {}
    }

    if (!ok) ok = await robustTripSave(id, { endedAt: ts, endLocation: where || undefined, status: "ended" });

    if (ok) {
      try {
        const got = (await api.get(`/vehicle-trips/${id}`)).data;
        setTrips((prev) => prev.map((x) => (x._id === id ? got : x)));
      } catch {
        try {
          const got = (await api.get(`/trips/${id}`)).data;
          setTrips((prev) => prev.map((x) => (x._id === id ? got : x)));
        } catch {}
      }
      setInfo("Trip ended.");
    }
  }

  // ---------- Soft delete / restore ----------
  async function softDelete(id) {
    if (!confirm("Delete this trip?")) return;
    setErr("");
    setInfo("");
    try {
      try {
        await api.delete(`/vehicle-trips/${id}`);
      } catch {
        await api.delete(`/trips/${id}`);
      }
      await loadTrips();
      setInfo("Trip deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function restore(id) {
    setErr("");
    setInfo("");
    try {
      let data;
      try {
        ({ data } = await api.patch(`/vehicle-trips/${id}/restore`));
      } catch {
        ({ data } = await api.patch(`/trips/${id}/restore`));
      }
      setTrips((prev) => prev.map((t) => (t._id === id ? data : t)));
      setInfo("Trip restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const filtered = useMemo(() => trips, [trips]);

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold mb-3">Vehicle Trips</h1>
      {err && <div className="text-red-600 mb-2">{err}</div>}
      {info && <div className="text-green-700 mb-2">{info}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          className="border p-2"
          placeholder="Search… (plate/driver/notes)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadTrips()}
          style={{ minWidth: 280 }}
        />
        <select className="border p-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status (any)</option>
          <option value="not_started">not_started</option>
          <option value="in_progress">in_progress</option>
          <option value="ended">ended</option>
        </select>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          Include deleted
        </label>
        <button className="px-3 py-2 border rounded" onClick={loadTrips}>
          Apply
        </button>
      </div>

      <form onSubmit={createTrip} className="grid md:grid-cols-4 gap-2 border rounded p-3 mb-4">
        <label className="text-sm">
          Vehicle
          <select className="border p-2 w-full" value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })} required>
            <option value="">— select —</option>
            {vehicles.map((v) => (
              <option key={v._id || v.id} value={String(v._id || v.id)}>
                {v.name || v.reg || v.registration || v.plate || v.title || v._id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Driver
          <select className="border p-2 w-full" value={form.driverId} onChange={(e) => setForm({ ...form, driverId: e.target.value })}>
            <option value="">— none —</option>
            {users.map((u) => (
              <option key={u._id} value={String(u._id)}>
                {u.name || u.email || u.username}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          Notes
          <input className="border p-2 w-full" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" />
        </label>
        <div className="md:col-span-4">
          <button className="px-3 py-2 bg-black text-white rounded">Create Trip</button>
        </div>
      </form>

      <table className="w-full border text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="border p-2 text-left">Vehicle</th>
            <th className="border p-2 text-left">Driver</th>
            <th className="border p-2 text-left">Status</th>
            <th className="border p-2 text-left">Start</th>
            <th className="border p-2 text-left">End</th>
            <th className="border p-2 text-left">Notes</th>
            <th className="border p-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t) => {
            const isEditing = editing && editing._id === t._id;
            const s = t.status || "not_started";
            return (
              <tr key={t._id} className={t.deletedAt ? "opacity-60" : ""}>
                <td className="border p-2">
                  {isEditing ? (
                    <select className="border p-1" value={editing.vehicleId} onChange={(e) => setEditing({ ...editing, vehicleId: e.target.value })}>
                      <option value="">— none —</option>
                      {vehicles.map((v) => (
                        <option key={v._id || v.id} value={String(v._id || v.id)}>
                          {v.name || v.reg || v.registration || v.plate || v.title || v._id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div>{vehicleName(t.vehicleId || t.vehicle)}</div>
                  )}
                </td>
                <td className="border p-2">
                  {isEditing ? (
                    <select className="border p-1" value={editing.driverId} onChange={(e) => setEditing({ ...editing, driverId: e.target.value })}>
                      <option value="">— none —</option>
                      {users.map((u) => (
                        <option key={u._id} value={String(u._id)}>
                          {u.name || u.email || u.username}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div>{userName(t.driverId || t.driver)}</div>
                  )}
                </td>
                <td className="border p-2">
                  {isEditing ? (
                    <select className="border p-1" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                      <option value="not_started">not_started</option>
                      <option value="in_progress">in_progress</option>
                      <option value="ended">ended</option>
                    </select>
                  ) : (
                    <Tag>{s}</Tag>
                  )}
                </td>
                <td className="border p-2">
                  {isEditing ? (
                    <input
                      className="border p-1 w-44"
                      type="datetime-local"
                      value={editing.startedAt ? new Date(editing.startedAt).toISOString().slice(0, 16) : ""}
                      onChange={(e) => setEditing({ ...editing, startedAt: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                    />
                  ) : (
                    <div className="text-xs">{fmtDT(t.startedAt || t.startAt || t.started)}</div>
                  )}
                </td>
                <td className="border p-2">
                  {isEditing ? (
                    <input
                      className="border p-1 w-44"
                      type="datetime-local"
                      value={editing.endedAt ? new Date(editing.endedAt).toISOString().slice(0, 16) : ""}
                      onChange={(e) => setEditing({ ...editing, endedAt: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                    />
                  ) : (
                    <div className="text-xs">{fmtDT(t.endedAt || t.endAt || t.ended)}</div>
                  )}
                </td>
                <td className="border p-2">
                  {isEditing ? (
                    <input className="border p-1 w-full" value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} placeholder="Notes" />
                  ) : (
                    <div className="text-xs">{t.notes || "—"}</div>
                  )}
                </td>
                <td className="border p-2 text-right">
                  {!t.deletedAt ? (
                    <div className="inline-flex items-center gap-2">
                      {!isEditing && s !== "in_progress" && s !== "ended" && (
                        <button className="px-2 py-1 border rounded" onClick={() => startTrip(t)}>
                          Start
                        </button>
                      )}
                      {!isEditing && s === "in_progress" && (
                        <button className="px-2 py-1 border rounded" onClick={() => endTrip(t)}>
                          End
                        </button>
                      )}
                      {!isEditing ? (
                        <button className="px-2 py-1 border rounded" onClick={() => beginEdit(t)}>
                          Edit
                        </button>
                      ) : (
                        <>
                          <button className="px-2 py-1 border rounded" onClick={saveEdit}>
                            Save
                          </button>
                          <button className="px-2 py-1 border rounded" onClick={cancelEdit}>
                            Cancel
                          </button>
                        </>
                      )}
                      <button className="px-2 py-1 border rounded" onClick={() => softDelete(t._id)}>
                        Delete
                      </button>
                    </div>
                  ) : (
                    <button className="px-2 py-1 border rounded" onClick={() => restore(t._id)}>
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!filtered.length && (
            <tr>
              <td className="p-4 text-center" colSpan={7}>
                No trips
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
