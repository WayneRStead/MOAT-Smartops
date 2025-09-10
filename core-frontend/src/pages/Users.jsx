import { useEffect, useState } from "react";
import { getUsers } from "../api";

export default function Users() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => { getUsers().then(setRows).catch(e => setErr(e.message)); }, []);

  return (
    <div className="card">
      <h2>Users ({rows.length})</h2>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      <table className="table">
        <thead>
          <tr><th>Name</th><th>Role</th><th>Email</th></tr>
        </thead>
        <tbody>
          {rows.map(u => (
            <tr key={u._id || u.id}>
              <td>{u.name}</td>
              <td>{u.role || "-"}</td>
              <td>{u.email || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
