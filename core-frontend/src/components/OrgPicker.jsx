import React from "react";

export default function OrgPicker({ open, orgs, onPick, onClose }) {
  if (!open) return null;
  return (
    <div className="lb-wrap" onClick={onClose}>
      <div className="lb" onClick={e=>e.stopPropagation()}>
        <div className="lb-head">
          <div className="lb-title">Choose an organization</div>
          <button className="lb-x" onClick={onClose}>×</button>
        </div>
        <div className="lb-body">
          {orgs.map(o => (
            <div key={o.orgId} className="row" style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border)"}}>
              <div>
                <div style={{fontWeight:600}}>{o.orgName || o.name || o.orgId}</div>
                <small className="muted">{Array.isArray(o.roles)?o.roles.join(", "):""}</small>
              </div>
              <button className="btn-primary" onClick={()=>onPick(o.orgId)}>Use this org</button>
            </div>
          ))}
        </div>
      </div>
      <style>{`
        .lb-wrap{ position:fixed; inset:0; background:rgba(0,0,0,.45); display:grid; place-items:center; z-index:9999; }
        .lb{ background:#fff; width:min(600px,92vw); max-height:80vh; display:grid; grid-template-rows:auto 1fr; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
        .lb-head{ display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border); }
        .lb-title{ font-weight:700; }
        .lb-x{ background:none; border:none; font-size:22px; cursor:pointer; line-height:1; }
        .lb-body{ overflow:auto; padding:12px 16px; }
      `}</style>
    </div>
  );
}
