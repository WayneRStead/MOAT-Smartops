import { useEffect, useState } from "react";
import { getInvoices } from "../api";

export default function Invoices() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => { getInvoices().then(setRows).catch(e => setErr(e.message)); }, []);

  return (
    <div className="card">
      <h2>Invoices ({rows.length})</h2>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      <table className="table">
        <thead>
          <tr><th>Number</th><th>Project</th><th>Amount</th><th>Status</th></tr>
        </thead>
        <tbody>
          {rows.map(i => (
            <tr key={i._id || i.id}>
              <td>{i.number}</td>
              <td>{i.projectId?.name || i.projectId || "-"}</td>
              <td>{typeof i.amount === "number" ? i.amount.toFixed(2) : "-"}</td>
              <td>{i.status || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
