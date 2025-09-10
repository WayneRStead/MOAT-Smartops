import { useEffect, useState } from "react";

export default function CostPreview(){
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("token") || "";
    fetch("/api/billing/preview", { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async r => { if(!r.ok) throw new Error(await r.text()); return r.json(); })
      .then(setData)
      .catch(e => setErr(String(e)));
  }, []);

  if (err) return <p style={{color:'crimson'}}>{err}</p>;
  if (!data) return <p>Loading cost preview…</p>;

  return (
    <div style={{ display:'grid', gap:8 }}>
      <div style={{ opacity:.8 }}>Month: {data.month}</div>
      <table className="table">
        <thead>
          <tr><th>Meter</th><th>Used</th><th>Allow</th><th>Over</th><th>Unit</th><th>Subtotal</th></tr>
        </thead>
        <tbody>
          {data.lines.map(l=>(
            <tr key={l.code}>
              <td>{l.code}</td>
              <td>{l.used}</td>
              <td>{l.allow}</td>
              <td>{l.over}</td>
              <td>{l.unit}</td>
              <td>{l.subtotal.toFixed(2)}</td>
            </tr>
          ))}
          {!data.lines.length && <tr><td colSpan={6} style={{opacity:.7}}>No overages.</td></tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={5} style={{textAlign:'right'}}>Subtotal</td><td>{data.subtotal.toFixed(2)}</td></tr>
          <tr><td colSpan={5} style={{textAlign:'right'}}>Tax ({(data.taxRate*100).toFixed(0)}%)</td><td>{data.tax.toFixed(2)}</td></tr>
          <tr><td colSpan={5} style={{textAlign:'right', fontWeight:600}}>Total</td><td style={{fontWeight:600}}>{data.total.toFixed(2)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}
