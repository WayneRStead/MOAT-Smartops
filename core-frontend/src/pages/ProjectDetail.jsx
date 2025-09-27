// src/pages/ProjectDetail.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { listProjectTasks } from "../lib/api";
import ProjectTasksTimeline from "../components/ProjectTasksTimeline";
import AssignInspectionForms from "../components/AssignInspectionForms.jsx";

const TASK_PALETTE = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf","#ef4444","#10b981"];
const normalizeHex = (c) => { if(!c) return ""; const m=String(c).trim(); return /^#?[0-9a-f]{6}$/i.test(m)?(m.startsWith("#")?m:`#${m}`):""; };
const hexToRgba = (hex, a = 0.2) => { const h=normalizeHex(hex).slice(1); if(h.length!==6) return `rgba(0,0,0,${a})`; const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16); return `rgba(${r},${g},${b},${a})`; };
const asId = (maybe) => typeof maybe === "string" || typeof maybe === "number" ? String(maybe) : (maybe && (maybe._id || maybe.id || maybe.userId || maybe.value)) ? String(maybe._id || maybe.id || maybe.userId || maybe.value) : "";

// Normalize how we read the current manager from the project (covers multiple backend shapes)
const getManagerIdFromProject = (proj) =>
  asId(
    proj?.manager ??
    proj?.managerId ??
    proj?.managerUserId ??
    proj?.owner ??
    proj?.ownerId ??
    proj?.projectManager ??
    proj?.projectManagerId ??
    (proj?.team && proj.team.manager) ??
    null
  );

function SafeGeoFencePreview(props){
  const [Loaded, setLoaded] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let mnt = true;
    import("../components/GeoFencePreview")
      .then((m) => mnt && setLoaded(()=>m.default))
      .catch(()=> mnt && setErr("Map preview unavailable (Leaflet not installed)."));
    return ()=>{ mnt=false; };
  },[]);
  if (err) return <div className="flex items-center justify-center rounded text-sm text-gray-600" style={{height: props.height||360}}>{err}</div>;
  if (!Loaded) return <div className="flex items-center justify-center bg-gray-100 rounded text-sm text-gray-600" style={{height: props.height||360}}>Loading map…</div>;
  const C = Loaded;
  return <C {...props} />;
}

function TagEditor({ value = [], onChange }) {
  const [text, setText] = useState((value || []).join(", "));
  useEffect(() => setText((value || []).join(", ")), [value]);
  return (
    <input className="border p-2 w-full" placeholder="site-a, osha" value={text}
      onChange={(e) => { setText(e.target.value); onChange?.(e.target.value.split(",").map(s=>s.trim()).filter(Boolean)); }} />
  );
}

export default function ProjectDetail(){
  const { id } = useParams();
  const navigate = useNavigate();

  const [p,setP] = useState(null);
  const [err,setErr] = useState("");
  const [info,setInfo] = useState("");

  const [users,setUsers] = useState([]);
  const [projectTasks,setProjectTasks] = useState([]);

  const [docs,setDocs] = useState([]);
  const [docQuery,setDocQuery] = useState("");
  const [docPick,setDocPick] = useState("");

  const [inspections,setInspections] = useState([]);
  const [inspErr,setInspErr] = useState("");
  const [inspInfo,setInspInfo] = useState("");
  const [inspForm,setInspForm] = useState({ title:"", status:"planned", scheduledAt:"", assignee:"" });

  // Proof (Vault)
  const [proofUser,setProofUser] = useState("");
  const [proofTitle,setProofTitle] = useState("");
  const [proofTags,setProofTags] = useState("");
  const [proofFile,setProofFile] = useState(null);
  const [proofErr,setProofErr] = useState("");
  const [proofInfo,setProofInfo] = useState("");

  // Location helpers
  const [lat,setLat] = useState("");
  const [lng,setLng] = useState("");
  const [radius,setRadius] = useState("");

  // Geofences summary
  const [gfFile,setGfFile] = useState(null);
  const [gfBuffer,setGfBuffer] = useState(50);
  const [gfCount,setGfCount] = useState(0);
  const [gfSource,setGfSource] = useState("none");
  const [replaceFences,setReplaceFences] = useState(true);

  // Overlays
  const [showTaskPins,setShowTaskPins] = useState(true);
  const [showTaskAreas,setShowTaskAreas] = useState(true);
  const [taskGfByTask,setTaskGfByTask] = useState({});
  const [taskGfLoading,setTaskGfLoading] = useState(false);

  // Load data
  useEffect(()=>{ loadProject(); loadUsers(); loadDocs(); loadInspections(); loadProjectTasks(); },[id]); // eslint-disable-line

  async function loadProject(){
    setErr(""); setInfo("");
    try{ const {data} = await api.get(`/projects/${id}`, { params: { _ts: Date.now() } }); setP(data); await refreshFenceSummary(true); }
    catch(e){ setErr(e?.response?.data?.error || String(e)); }
  }
  async function loadUsers(){ try{ const {data} = await api.get("/users",{params:{limit:500}}); setUsers(Array.isArray(data)?data:[]);}catch{ setUsers([]);} }
  async function loadDocs(q=""){ try{ const params={limit:50}; if(q) params.q=q; const {data}=await api.get("/documents",{params}); setDocs(Array.isArray(data)?data:[]);}catch{ setDocs([]);} }
  async function loadInspections(){ try{ const {data}=await api.get("/inspections",{params:{projectId:id,limit:200}}); setInspections(Array.isArray(data)?data:[]); setInspErr(""); }catch(e){ setInspErr(e?.response?.data?.error||"Failed to load inspections"); } }
  async function loadProjectTasks(){ try{ const rows = await listProjectTasks(id,{limit:1000}); setProjectTasks(Array.isArray(rows)?rows:[]);}catch{ setProjectTasks([]);} }

  // Task geofences (for overlays)
  useEffect(()=>{
    if (!showTaskAreas || !(projectTasks && projectTasks.length)){ setTaskGfByTask({}); return; }
    let cancelled=false;
    (async()=>{
      setTaskGfLoading(true);
      try{
        const ids = projectTasks.map(t=>String(t._id)).filter(Boolean);
        const next = {};
        const chunk = 5;
        for (let i=0;i<ids.length;i+=chunk){
          const slice = ids.slice(i,i+chunk);
          const res = await Promise.all(slice.map(async(tid)=>{
            try{
              // ⬇️ cache-busting param instead of forbidden request header
              const {data} = await api.get(`/tasks/${tid}/geofences`, { params: { _ts: Date.now() } });
              const list = (Array.isArray(data?.geoFences)&&data.geoFences) || (Array.isArray(data?.fences)&&data.fences) || (Array.isArray(data)&&data) || [];
              return { taskId: tid, fences: list };
            }catch{ return { taskId: tid, fences: [] }; }
          }));
          res.forEach(r=>{ next[r.taskId]=r.fences; });
          if (cancelled) return;
        }
        if (!cancelled) setTaskGfByTask(next);
      }finally{ if(!cancelled) setTaskGfLoading(false); }
    })();
    return ()=>{ cancelled=true; };
  },[projectTasks,showTaskAreas]);

  // ---------- Manager only (members removed) ----------
  const managerId = useMemo(()=> getManagerIdFromProject(p) || "", [p]);
  const [managerDraft, setManagerDraft] = useState(managerId);
  useEffect(()=> setManagerDraft(managerId), [managerId]);
  const managerDirty = String(managerDraft||"") !== String(managerId||"");

  async function robustSaveManager(){
    setErr(""); setInfo("");
    const m = String(managerDraft || "");

    // Try common payload shapes
    const shapes = [
      { manager: m || null },
      { managerId: m || null },
      { managerUserId: m || null },
      { owner: m || null },
      { ownerId: m || null },
      { projectManager: m || null },
      { projectManagerId: m || null },
      { team: { manager: m || null } },
      { manager: m ? { _id: m } : null },
    ];

    let lastErr;
    for (const patch of shapes) {
      try {
        try { await api.put(`/projects/${id}`, patch); } catch { await api.patch(`/projects/${id}`, patch); }
        const { data } = await api.get(`/projects/${id}`, { params: { _ts: Date.now() } });
        const got = getManagerIdFromProject(data);
        if (String(got||"") === String(m||"")) {
          setP(data);
          setInfo("Manager saved."); setTimeout(()=>setInfo(""),1200);
          return true;
        }
      } catch (e) { lastErr = e; }
    }

    // Try dedicated endpoints if any exist
    const endpointAttempts = [
      { m: "patch", u: `/projects/${id}/manager`, b: { manager: m || null } },
      { m: "put",   u: `/projects/${id}/manager`, b: { manager: m || null } },
      { m: "post",  u: `/projects/${id}/manager`, b: { manager: m || null } },
    ];
    for (const a of endpointAttempts) { try { await api[a.m](a.u, a.b); } catch {} }

    try {
      const { data } = await api.get(`/projects/${id}`, { params: { _ts: Date.now() } });
      const got = getManagerIdFromProject(data);
      if (String(got||"") === String(m||"")) {
        setP(data);
        setInfo("Manager saved."); setTimeout(()=>setInfo(""),1200);
        return true;
      }
    } catch (e) { lastErr = e; }

    setErr(lastErr?.response?.data?.error || "Could not persist manager on the server.");
    return false;
  }
  // ----------------------------------------------------

  // Generic save (for basic fields)
  async function save(patch){
    try{
      const {data}=await api.put(`/projects/${id}`, patch);
      setP(prev => ({ ...(prev||{}), ...(data||{}), ...patch }));
      setInfo("Saved"); setTimeout(()=>setInfo(""),1200);
    }catch(e){ setErr(e?.response?.data?.error || String(e)); }
  }

  // ✅ Use standard PUT to update status (works with our backend)
  async function setStatus(newStatus){
    await save({ status: newStatus });
  }

  async function softDelete(){ if(!confirm("Delete this project?")) return;
    try{ await api.delete(`/projects/${id}`); await loadProject(); setInfo("Project deleted."); }
    catch(e){ setErr(e?.response?.data?.error || String(e)); }
  }
  async function restore(){ try{ const {data}=await api.patch(`/projects/${id}/restore`); setP(prev=>({...prev,...data,deletedAt:null})); setInfo("Project restored."); }catch(e){ setErr(e?.response?.data?.error || String(e)); } }

  // Vault links
  async function linkDoc(){ if(!docPick) return;
    try{ await api.post(`/documents/${docPick}/links`,{type:"project",refId:id}); setInfo("Linked document."); }
    catch(e){ setErr(e?.response?.data?.error || String(e)); }
  }
  async function unlinkDoc(docId){
    try{ await api.delete(`/documents/${docId}/links`,{data:{type:"project",refId:id}}); setInfo("Unlinked document."); }
    catch(e){ setErr(e?.response?.data?.error || String(e)); }
  }
  const linkedDocs = useMemo(()=>{
    const ref = String(id);
    return (docs||[]).filter(d => (d.links||[]).some(l => (l.type||l.module)==="project" && String(l.refId)===ref));
  },[docs,id]);

  // Proof
  async function attachProof(e){
    e.preventDefault(); setProofErr(""); setProofInfo("");
    if(!proofUser) return setProofErr("Pick a user.");
    if(!proofFile) return setProofErr("Choose a file.");
    try{
      const title = (proofTitle || proofFile.name || "Proof").trim();
      const tags = (proofTags||"").split(",").map(s=>s.trim()).filter(Boolean);
      const {data:doc} = await api.post("/documents",{
        title, folder:`projects/${id}/proof`, tags,
        links:[{type:"project",refId:id},{type:"user",refId:proofUser}],
        access:{visibility:"org"},
      });
      const fd = new FormData(); fd.append("file", proofFile);
      await api.post(`/documents/${doc._id}/upload`, fd, { headers:{"Content-Type":"multipart/form-data"} });
      setProofInfo("Proof attached via Vault."); setProofFile(null); setProofTitle(""); setProofTags(""); setProofUser("");
      loadDocs();
    }catch(e){ setProofErr(e?.response?.data?.error || String(e)); }
  }

  // Geofence helpers
  function makeCirclePolygon(lat, lng, radiusMeters, steps=64){
    const R=6371000, lat1=(lat*Math.PI)/180, lon1=(lng*Math.PI)/180, d=radiusMeters/R;
    const ring=[]; for(let i=0;i<=steps;i++){ const brng=(2*Math.PI*i)/steps; const sinLat1=Math.sin(lat1), cosLat1=Math.cos(lat1), sinD=Math.sin(d), cosD=Math.cos(d);
      const sinLat2=sinLat1*cosD + cosLat1*sinD*Math.cos(brng); const lat2=Math.asin(sinLat2);
      const y=Math.sin(brng)*sinD*cosLat1; const x=cosD - sinLat1*sinLat2; const lon2=lon1+Math.atan2(y,x);
      ring.push([((lon2*180)/Math.PI+540)%360-180, (lat2*180)/Math.PI]); }
    return ring;
  }
  async function refreshFenceSummary(prefill=false){
    try{
      // ⬇️ cache-busting param instead of forbidden request header
      const {data}=await api.get(`/projects/${id}/geofences`, { params: { _ts: Date.now() } });
      const fences = Array.isArray(data?.geoFences)?data.geoFences : Array.isArray(data?.fences)?data.fences : Array.isArray(data)?data : [];
      setGfCount(fences.length); setGfSource(fences.length?"project":"none");
      if(prefill){
        const circle = fences.find(f=>String(f?.type).toLowerCase()==="circle");
        if(circle){
          let L2,G2,R2;
          if (circle.center){ if(Array.isArray(circle.center)){ G2=Number(circle.center[0]); L2=Number(circle.center[1]); } else { L2=Number(circle.center.lat); G2=Number(circle.center.lng); } }
          if ((L2===undefined||G2===undefined) && circle.point){ G2=Number(circle.point.lng); L2=Number(circle.point.lat); }
          R2=Number(circle.radius ?? circle.radiusMeters);
          if(Number.isFinite(L2)) setLat(String(L2)); if(Number.isFinite(G2)) setLng(String(G2)); if(Number.isFinite(R2)) setRadius(String(R2));
        }
      }
    }catch{ setGfCount(0); setGfSource("none"); }
  }
  function circleFromInputs(){ if(lat===""||lng==="") return null; const L2=Number(lat), G2=Number(lng), R2=radius===""?50:Number(radius);
    if(!Number.isFinite(L2)||!Number.isFinite(G2)||!Number.isFinite(R2)) return null; return {lat:L2,lng:G2,radius:R2}; }
  async function persistCircleAsPolygon(projectId,{lat,lng,radius}){
    const polygon = makeCirclePolygon(lat,lng,radius,64);
    const body = { geoFences: [{ type:"polygon", polygon }] };
    try{ if (replaceFences) await api.delete(`/projects/${projectId}/geofences`);}catch{}
    const attempts=[{m:"patch",u:`/projects/${projectId}/geofences`,b:body},{m:"post",u:`/projects/${projectId}/geofences`,b:body},{m:"put",u:`/projects/${projectId}/geofences`,b:body}];
    let lastErr; for (const a of attempts){ try{ await api[a.m](a.u,a.b,{headers:{"Content-Type":"application/json"}}); return {ok:true}; }catch(e){ lastErr=e; } }
    try{ await api.delete(`/projects/${projectId}/geofences`);}catch{}; try{ await api.post(`/projects/${projectId}/geofences`,body,{headers:{"Content-Type":"application/json"}}); return {ok:true}; }catch(e2){ return {ok:false,error:lastErr||e2}; }
  }
  async function handleSaveLocation(e){
    e?.preventDefault?.(); setErr(""); setInfo("");
    const c = circleFromInputs(); if(!c){ setErr("Please enter valid Lat, Lng and Radius."); return; }
    const {ok,error} = await persistCircleAsPolygon(id,c);
    if(!ok){ setErr(error?.response?.data?.error || String(error) || "Failed to save location."); return; }
    await refreshFenceSummary(true); setInfo("Location saved."); setTimeout(()=>setInfo(""),1200);
  }
  async function uploadGeofenceFile(e){
    e?.preventDefault?.(); setErr(""); setInfo("");
    if(!gfFile) return setErr("Choose a .geojson, .kml or .kmz file first.");
    try{
      if (replaceFences){ try{ await api.delete(`/projects/${id}/geofences`);}catch{} }
      const fd=new FormData(); fd.append("file",gfFile);
      const qs=[`radius=${encodeURIComponent(Number(gfBuffer)||50)}`,`buffer=${encodeURIComponent(Number(gfBuffer)||50)}`,`radiusMeters=${encodeURIComponent(Number(gfBuffer)||50)}`];
      let lastErr; for(const q of qs){ try{ await api.post(`/projects/${id}/geofences/upload?${q}`,fd); setGfFile(null); await refreshFenceSummary(true); setInfo(replaceFences?"Fences replaced with uploaded file.":"Fences uploaded (appended)."); setTimeout(()=>setInfo(""),1200); return; }catch(eTry){ lastErr=eTry; } }
      throw lastErr||new Error("Upload failed");
    }catch(e2){ setErr(e2?.response?.data?.error || String(e2)); }
  }
  async function clearAllFences(){ if(!window.confirm("Remove ALL geofences from this project?")) return;
    setErr(""); setInfo("");
    try{ await api.delete(`/projects/${id}/geofences`); await refreshFenceSummary(true); setInfo("Project geofences cleared."); setTimeout(()=>setInfo(""),1200); }
    catch(e2){ setErr(e2?.response?.data?.error || String(e2)); }
  }
  function useMyLocation(){
    if(!navigator.geolocation){ setErr("Geolocation not supported by this browser."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos)=>{ setLat(pos.coords.latitude.toFixed(6)); setLng(pos.coords.longitude.toFixed(6)); if(!radius) setRadius("50"); },
      (ge)=>setErr(ge?.message||"Failed to get current position"),
      { enableHighAccuracy:true, maximumAge:10000, timeout:10000 }
    );
  }

  // Normalizers for overlays
  function normPolygon(raw){ if(!Array.isArray(raw)) return null;
    const out = raw.map(p=> Array.isArray(p)?p:[Number(p.lng),Number(p.lat)]);
    return out.every(pt=>Array.isArray(pt)&&pt.length===2&&pt.every(Number.isFinite)) ? out : null;
  }
  function normLine(raw){ if(!Array.isArray(raw)) return null;
    const out = raw.map(p=> Array.isArray(p)?p:[Number(p.lng),Number(p.lat)]);
    return out.every(pt=>Array.isArray(pt)&&pt.length===2&&pt.every(Number.isFinite)) ? out : null;
  }
  function normCircle(raw){ const c=raw.center||raw.point||{};
    const lat=Number(c.lat??c[1]), lng=Number(c.lng??c[0]), r=Number(raw.radius??raw.radiusMeters??raw.r);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||!Number.isFinite(r)) return null;
    return { center:{lat,lng}, radius:r };
  }

  const userLabel = (maybe) => {
    const idStr = asId(maybe);
    const u = users.find(x=>String(x._id)===idStr);
    return u ? (u.name || u.email || u.username || idStr) : (idStr || "—");
  };

  // Per-task colours
  const taskColourMap = useMemo(()=>{
    const byId=new Map();
    (projectTasks||[]).forEach((t,i)=>{
      const explicit = normalizeHex(t.color || t.colour || t.hex);
      byId.set(String(t._id), explicit || TASK_PALETTE[i % TASK_PALETTE.length]);
    });
    return byId;
  },[projectTasks]);

  // Legend items (only tasks that render something)
  const legendItems = useMemo(()=>{
    if(!showTaskPins && !showTaskAreas) return [];
    const used = new Set();
    if(showTaskPins){ for(const t of projectTasks||[]){ const gf=t.locationGeoFence; if(gf && gf.lat!=null && gf.lng!=null) used.add(String(t._id)); } }
    if(showTaskAreas){ for(const t of projectTasks||[]){ const arr=taskGfByTask[String(t._id)]||[]; if(arr.length) used.add(String(t._id)); } }
    return (projectTasks||[]).filter(t=>used.has(String(t._id))).map(t=>({ id:String(t._id), title:t.title||"Task", color:taskColourMap.get(String(t._id)) }));
  },[projectTasks,taskGfByTask,showTaskPins,showTaskAreas,taskColourMap]);

  // Build overlays (pins + areas) for ALL tasks (colours carried in meta/style)
  const taskOverlays = useMemo(()=>{
    const out=[];
    if(showTaskPins){
      for(const t of projectTasks||[]){
        const gf=t.locationGeoFence;
        if(gf && gf.lat!=null && gf.lng!=null){
          const lat=Number(gf.lat), lng=Number(gf.lng); if(Number.isFinite(lat)&&Number.isFinite(lng)){
            const color = taskColourMap.get(String(t._id));
            out.push({
              id:`${t._id}-pin`,
              type:"Point",
              coordinates:[lng,lat],
              title:t.title || "Task",
              meta:{ label:t.title||"Task", taskId:String(t._id||""), color },
              style:{ stroke:color, fill:color, strokeWidth:2 },
            });
          }
        }
      }
    }
    if(showTaskAreas){
      for(const t of projectTasks||[]){
        const color = taskColourMap.get(String(t._id));
        const fences = taskGfByTask[String(t._id)] || [];
        for(const raw of fences){
          const type = String(raw?.type || raw?.kind || raw?.geometry?.type || "").toLowerCase();
          if (type==="polygon" || raw?.polygon || raw?.geometry?.type==="Polygon"){
            const poly = normPolygon(raw?.polygon) || (Array.isArray(raw?.geometry?.coordinates) && Array.isArray(raw.geometry.coordinates[0]) && normPolygon(raw.geometry.coordinates[0])) || null;
            if(poly){ out.push({ id:`${t._id}-poly-${out.length}`, type:"polygon", polygon:poly, meta:{label:t.title||"Task", taskId:String(t._id||""), color}, style:{ stroke:color, strokeWidth:2, fill:hexToRgba(color,0.2) } }); continue; }
          }
          if (type==="polyline" || type==="line" || Array.isArray(raw?.line) || Array.isArray(raw?.path)){
            const line = normLine(raw.line||raw.path);
            if(line){ out.push({ id:`${t._id}-line-${out.length}`, type:"polyline", line, meta:{label:t.title||"Task", taskId:String(t._id||""), color}, style:{ stroke:color, strokeWidth:3 } }); continue; }
          }
          if (type==="circle" || raw?.radius || raw?.radiusMeters){
            const c = normCircle(raw);
            if(c){ out.push({ id:`${t._id}-circle-${out.length}`, type:"circle", center:c.center, radius:c.radius, meta:{label:t.title||"Task", taskId:String(t._id||""), color}, style:{ stroke:color, strokeWidth:2, fill:hexToRgba(color,0.2) } }); continue; }
          }
          if (type==="point" || raw?.geometry?.type==="Point"){
            const coords = Array.isArray(raw?.coordinates)?raw.coordinates : Array.isArray(raw?.geometry?.coordinates)?raw.geometry.coordinates : null;
            if (Array.isArray(coords) && coords.length>=2 && coords.every(Number.isFinite)){
              out.push({ id:`${t._id}-pt-${out.length}`, type:"Point", coordinates:coords, meta:{label:t.title||"Task", taskId:String(t._id||""), color}, style:{ stroke:color, fill:color, strokeWidth:2 } });
            }
          }
        }
      }
    }
    return out;
  },[projectTasks,taskGfByTask,showTaskPins,showTaskAreas,taskColourMap]);

  // Hover resolver so tooltips show richer info
  function hoverMetaResolver(overlay) {
    const tid = String(overlay?.meta?.taskId || "");
    const t = (projectTasks || []).find((x) => String(x._id) === tid);
    if (!t) return null;
    return {
      taskName: t.title || "Task",
      assigneeName: t.assignee ? userLabel(t.assignee) : "",
      status: t.status || "",
      due: t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "",
      color: taskColourMap.get(tid),
    };
  }
  const overlayStyleResolver = (o) => o?.style || { color: o?.meta?.color, fillColor: o?.meta?.color };

  // Inspections helpers
  const resolveAssigneeName = (ins) => {
    const obj = (ins && typeof ins.assignee==="object" && ins.assignee) || (ins && typeof ins.user==="object" && ins.user) || null;
    if (obj) return obj.name || obj.email || obj.username || asId(obj) || "—";
    const id = asId(ins?.assignee) || asId(ins?.assigneeId) || asId(ins?.assigneeUserId) || asId(ins?.userId) || asId(ins?.user);
    if (!id) return "—";
    const u = users.find(x=>String(x._id)===String(id));
    return u ? (u.name||u.email||u.username) : id;
  };
  const resolveWhen = (ins) => {
    const cand = ins?.scheduledAt || ins?.scheduled_at || ins?.scheduled || ins?.dueAt || ins?.startAt || ins?.startDate || ins?.date || null;
    if (!cand) return "—"; const d = new Date(cand); return isNaN(d.getTime()) ? String(cand) : d.toLocaleString();
  };
  async function createInspection(e){
    e.preventDefault(); setInspErr(""); setInspInfo("");
    try{
      const payload={ title:(inspForm.title||"").trim(), status:inspForm.status||"planned", projectId:id, scheduledAt: inspForm.scheduledAt || undefined, assignee: inspForm.assignee || undefined };
      if(!payload.title) return setInspErr("Title is required");
      const {data}=await api.post("/inspections",payload);
      setInspections(prev=>[data,...prev]);
      setInspForm({ title:"", status:"planned", scheduledAt:"", assignee:"" });
      setInspInfo("Inspection created.");
    }catch(e2){ setInspErr(e2?.response?.data?.error || String(e2)); }
  }
  async function updateInspectionStatus(inspId,status){
    try{ const {data}=await api.put(`/inspections/${inspId}`,{status}); setInspections(prev=>prev.map(i=>i._id===inspId?data:i)); }
    catch(e2){ setInspErr(e2?.response?.data?.error || String(e2)); }
  }
  async function deleteInspection(inspId){ if(!confirm("Delete this inspection?")) return;
    try{ await api.delete(`/inspections/${inspId}`); await loadInspections(); setInspInfo("Inspection deleted."); }
    catch(e2){ setInspErr(e2?.response?.data?.error || String(e2)); }
  }
  async function restoreInspection(inspId){
    try{ const {data}=await api.patch(`/inspections/${inspId}/restore`); setInspections(prev=>prev.map(i=>i._id===inspId?data:i)); setInspInfo("Inspection restored."); }
    catch(e2){ setInspErr(e2?.response?.data?.error || String(e2)); }
  }

  if(!p){ return <div className="p-4">Loading… {err && <span style={{color:"crimson"}}>({err})</span>}</div>; }

  const fallbackCircle = (gfCount===0 && lat!=="" && lng!=="") ? (()=>{ const L2=Number(lat), G2=Number(lng), R2=radius===""?50:Number(radius); return (Number.isFinite(L2)&&Number.isFinite(G2)&&Number.isFinite(R2))?{lat:L2,lng:G2,radius:R2}:null; })() : null;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Project</h1>
        <div className="flex gap-2">
          {!p.deletedAt ? <button className="px-3 py-2 border rounded" onClick={softDelete}>Delete</button>
                        : <button className="px-3 py-2 border rounded" onClick={restore}>Restore</button>}
          <button className="px-3 py-2 border rounded" onClick={()=>navigate(-1)}>Back</button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Meta */}
        <div className="border rounded p-3 space-y-3">
          <label className="block text-sm">
            Name
            <input className="border p-2 w-full" value={p.name||""}
              onChange={(e)=>setP({...p,name:e.target.value})}
              onBlur={()=>p.name && save({name:p.name})}/>
          </label>

          <label className="block text-sm">
            Status
            <select className="border p-2 w-full" value={p.status||"active"} onChange={(e)=>setStatus(e.target.value)}>
              <option value="active">active</option><option value="paused">paused</option><option value="closed">closed</option>
            </select>
          </label>

          <label className="block text-sm">
            Description
            <textarea className="border p-2 w-full" rows={3} value={p.description||""}
              onChange={(e)=>setP({...p,description:e.target.value})}
              onBlur={()=>save({description:p.description||""})}/>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Start
              <input className="border p-2 w-full" type="date"
                value={p.startDate ? p.startDate.slice(0,10) : ""}
                onChange={(e)=>setP({...p,startDate:e.target.value?new Date(e.target.value).toISOString():""})}
                onBlur={()=>save({startDate:p.startDate || undefined})}/>
            </label>
            <label className="block text-sm">
              End
              <input className="border p-2 w-full" type="date"
                value={p.endDate ? p.endDate.slice(0,10) : ""}
                onChange={(e)=>setP({...p,endDate:e.target.value?new Date(e.target.value).toISOString():""})}
                onBlur={()=>save({endDate:p.endDate || undefined})}/>
            </label>
          </div>

          <label className="block text-sm">
            Tags
            <TagEditor value={p.tags||[]} onChange={(t)=>{ setP({...p,tags:t}); save({tags:t}); }} />
          </label>

          <div className="text-sm text-gray-600">
            Created: {p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}<br/>
            Updated: {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "—"}
            {p.deletedAt && (<><br/><span className="text-red-700">Deleted: {new Date(p.deletedAt).toLocaleString()}</span></>)}
          </div>
        </div>

        {/* Manager (members removed) + Proof */}
        <div className="border rounded p-3 space-y-3">
          <div className="font-semibold">Project Manager</div>

          <label className="block text-sm">
            Manager
            <select className="border p-2 w-full" value={managerDraft}
              onChange={(e)=> setManagerDraft(String(e.target.value||"")) }>
              <option value="">— none —</option>
              {users.map(u=> <option key={u._id} value={String(u._id)}>{u.name||u.email||u.username}</option>)}
            </select>
          </label>

          <div className="flex gap-2">
            <button className="px-3 py-2 border rounded" onClick={robustSaveManager} disabled={!managerDirty}>Save Manager</button>
            <button className="px-3 py-2 border rounded" onClick={()=>setManagerDraft(managerId)} disabled={!managerDirty}>Revert</button>
            {!managerDirty && <span className="self-center text-xs text-gray-500">Up to date</span>}
          </div>

          <div className="border rounded p-3 space-y-2">
            <div className="font-medium text-sm">Attach Proof (Vault)</div>
            {proofErr && <div className="text-red-600 text-sm">{proofErr}</div>}
            {proofInfo && <div className="text-green-700 text-sm">{proofInfo}</div>}
            <form onSubmit={attachProof} className="grid md:grid-cols-2 gap-2">
              <label className="text-sm">
                User
                <select className="border p-2 w-full" value={proofUser} onChange={(e)=>setProofUser(e.target.value)} required>
                  <option value="">— select a user —</option>
                  {users.map(u=><option key={u._id} value={String(u._id)}>{u.name||u.email||u.username}</option>)}
                </select>
              </label>
              <label className="text-sm">
                Title
                <input className="border p-2 w-full" placeholder="e.g. Sick note 2025-08-26" value={proofTitle} onChange={(e)=>setProofTitle(e.target.value)} />
              </label>
              <label className="text-sm md:col-span-2">
                Tags (comma)
                <input className="border p-2 w-full" placeholder="sick, proof" value={proofTags} onChange={(e)=>setProofTags(e.target.value)} />
              </label>
              <label className="text-sm md:col-span-2">
                File
                <input type="file" className="border p-2 w-full" onChange={(e)=>setProofFile(e.target.files?.[0]||null)} required />
              </label>
              <div className="md:col-span-2"><button className="px-3 py-2 bg-black text-white rounded">Attach</button></div>
            </form>
            <div className="text-xs text-gray-600">Files are stored in the Vault and auto-linked to this project and the selected user.</div>
          </div>
        </div>
      </div>

      {/* Location & Geofencing */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Project Location</div>
          <div className="text-sm text-gray-600">Fences: <b>{gfCount}</b> <span className="ml-2">source: <i>{gfSource}</i></span></div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={showTaskPins} onChange={(e)=>setShowTaskPins(e.target.checked)} />Show task pins</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={showTaskAreas} onChange={(e)=>setShowTaskAreas(e.target.checked)} />Show task geofences</label>
          {taskGfLoading && <span className="text-xs text-gray-700">Loading task areas…</span>}
        </div>

        {legendItems.length>0 && (
          <div className="sticky top-2 z-10 mt-2 max-h-28 overflow-auto rounded border bg-white/90 backdrop-blur px-3 py-2 text-xs shadow-sm">
            <div className="font-medium mb-1">Task Legend</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
              {legendItems.map(it=>(
                <div key={it.id} className="inline-flex items-center gap-2">
                  <svg width="14" height="14" aria-hidden focusable="false"><rect width="14" height="14" rx="2" ry="2" fill={it.color||"#999"} /></svg>
                  <span className="truncate" title={it.title}>{it.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <SafeGeoFencePreview
          projectId={id}
          height={360}
          className="rounded"
          reloadKey={`${gfCount}:${showTaskPins}:${showTaskAreas}:${projectTasks.length}:${Object.keys(taskGfByTask).length}:${p?.updatedAt||""}`}
          fallbackCircle={fallbackCircle}
          allowPicking={replaceFences || gfCount===0}
          onPickLocation={({lat:la,lng:lo})=>{
            setLat(la.toFixed(6)); setLng(lo.toFixed(6)); if(!radius) setRadius("50");
            setInfo(`Pin set at ${la.toFixed(6)}, ${lo.toFixed(6)} — click “Save location” to persist.`);
            setTimeout(()=>setInfo(""),2000);
          }}
          extraFences={taskOverlays}
          overlayStyleResolver={overlayStyleResolver}
          hoverMetaResolver={hoverMetaResolver}
        />

        <div className="flex items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={replaceFences} onChange={(e)=>setReplaceFences(e.target.checked)} />Replace existing fences (recommended)</label>
          <span className="text-gray-500">{replaceFences? "We'll clear existing fences before saving/uploading." : "We'll add to existing fences."}</span>
        </div>

        <form onSubmit={handleSaveLocation} className="grid md:grid-cols-5 gap-2">
          <label className="text-sm">Lat<input className="border p-2 w-full" value={lat} onChange={(e)=>setLat(e.target.value)} placeholder="-33.123456" /></label>
          <label className="text-sm">Lng<input className="border p-2 w-full" value={lng} onChange={(e)=>setLng(e.target.value)} placeholder="18.654321" /></label>
          <label className="text-sm">Radius (m)<input className="border p-2 w-full" type="number" min="5" value={radius} onChange={(e)=>setRadius(e.target.value)} placeholder="50" /></label>
          <div className="flex items-end gap-2 md:col-span-2">
            <button type="button" className="px-3 py-2 border rounded" onClick={useMyLocation}>Use my location</button>
            <a className="px-3 py-2 border rounded" href={lat&&lng?`https://www.google.com/maps?q=${lat},${lng}`:undefined} target="_blank" rel="noreferrer" onClick={(e)=>{ if(!(lat&&lng)) e.preventDefault(); }}>Open in Maps</a>
            <button className="px-3 py-2 bg-black text-white rounded ml-auto" type="submit">Save location</button>
          </div>
        </form>

        <form onSubmit={uploadGeofenceFile} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{minWidth:260}}>
            Upload .geojson / .kml / .kmz
            <input className="border p-2 w-full" type="file"
              accept=".geojson,.json,.kml,.kmz,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
              onChange={(e)=>setGfFile(e.target.files?.[0]||null)} />
          </label>
          <label className="text-sm">Geofence buffer size (m)
            <input className="border p-2 ml-2 w-28" type="number" min="1" step="1" value={gfBuffer} onChange={(e)=>setGfBuffer(e.target.value)} title="Used to buffer Point features into circles" />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">Upload Fences</button>
          <button className="px-3 py-2 border rounded" type="button" onClick={clearAllFences}>Clear Project Fences</button>
          <button className="px-3 py-2 border rounded" type="button" onClick={()=>refreshFenceSummary(true)}>Refresh</button>
        </form>

        <div className="text-xs text-gray-600">Saving a pin or uploading a file will <b>{replaceFences?"replace":"append to"}</b> the current fences.</div>
      </div>

      {/* Vault */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between"><div className="font-semibold">Linked Documents (Vault)</div><Link to="/vault" className="underline">Go to Vault</Link></div>
        <div className="flex flex-wrap items-end gap-2">
          <input className="border p-2" placeholder="Search docs…" value={docQuery} onChange={(e)=>{ setDocQuery(e.target.value); loadDocs(e.target.value); }} style={{minWidth:240}} />
          <select className="border p-2" value={docPick} onChange={(e)=>setDocPick(e.target.value)} style={{minWidth:320}}>
            <option value="">— select a document —</option>
            {docs.map(d=><option key={d._id} value={d._id}>{d.title} {d.folder?` • ${d.folder}`:""} {(d.tags||[]).length?` • ${d.tags.join(",")}`:""}</option>)}
          </select>
          <button className="px-3 py-2 border rounded" onClick={linkDoc} disabled={!docPick}>Link</button>
        </div>

        {linkedDocs.length ? (
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50"><th className="p-2 text-left">Title</th><th className="p-2 text-left">For</th><th className="p-2 text-left">Date</th><th className="p-2 text-left">Tags</th><th className="p-2 text-right">Actions</th></tr></thead>
            <tbody>
              {linkedDocs.map(d=>{
                const title=d.title || d.latest?.filename || "Document";
                const userLink=(d.links||[]).find(l=>(l.type||l.module)==="user");
                const userName=userLabel(userLink?.refId);
                const whenISO=d.latest?.uploadedAt || d.createdAt || d.updatedAt || null;
                const whenText=whenISO?new Date(whenISO).toLocaleString():"—";
                const tagsText=(d.tags||[]).join(", ");
                return (
                  <tr key={d._id}>
                    <td className="border-t p-2"><Link to={`/vault/${d._id}`} className="underline">{title}</Link></td>
                    <td className="border-t p-2">{userName}</td>
                    <td className="border-t p-2">{whenText}</td>
                    <td className="border-t p-2">{tagsText || "—"}</td>
                    <td className="border-t p-2 text-right">
                      <div className="inline-flex gap-2">
                        <Link to={`/vault/${d._id}`} className="px-2 py-1 border rounded">Open</Link>
                        <button className="px-2 py-1 border rounded" onClick={()=>unlinkDoc(d._id)}>Unlink</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ):<div className="text-sm text-gray-600">No linked documents.</div>}
      </div>

      {/* Tasks timeline (calendar-style mini Gantt) */}
      {projectTasks.length > 0 && (
        <ProjectTasksTimeline
          tasks={projectTasks}
          projectStart={p?.startDate || null}
          projectEnd={p?.endDate || null}
          title="Project tasks timeline"
        />
      )}

      {/* Tasks */}
      <div className="border rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Tasks for this Project</div>
          <div className="flex gap-2"><button className="px-3 py-2 border rounded" onClick={loadProjectTasks}>Refresh</button><Link to="/tasks" className="px-3 py-2 border rounded">Open Tasks</Link></div>
        </div>
        {projectTasks.length ? (
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50"><th className="p-2 text-left">Title</th><th className="p-2 text-left">Status</th><th className="p-2 text-left">Assignee</th><th className="p-2 text-left">Due</th><th className="p-2 text-right">Open</th></tr></thead>
            <tbody>
              {projectTasks.map((t,i)=>{
                const color = taskColourMap.get(String(t._id)) || TASK_PALETTE[i%TASK_PALETTE.length];
                return (
                  <tr key={t._id}>
                    <td className="border-t p-2">
                      <span className="inline-flex items-center gap-2">
                        <svg width="12" height="12" aria-hidden focusable="false"><rect width="12" height="12" rx="2" ry="2" fill={color} /></svg>
                        {t.title}
                      </span>
                    </td>
                    <td className="border-t p-2">{t.status}</td>
                    <td className="border-t p-2">{t.assignee ? userLabel(t.assignee) : "—"}</td>
                    <td className="border-t p-2">{t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}</td>
                    <td className="border-t p-2 text-right"><Link className="px-2 py-1 border rounded" to={`/tasks/${t._id}`}>Open</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ):<div className="text-sm text-gray-600">No tasks for this project.</div>}
      </div>

      {/* Inspections */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Inspections for this Project</div>
          <Link to="/inspections" className="underline">All inspections</Link>
        </div>

        {/* Assign org forms to this project / its tasks */}
        <div className="border rounded p-3 space-y-2">
          <div className="font-medium text-sm">Assign inspection forms</div>
          <AssignInspectionForms
            projectId={id}
            tasks={projectTasks}
            onChange={() => { loadInspections(); }}
          />
          <div className="text-xs text-gray-600">Assigned forms are scoped to this project (and optionally specific tasks), so users don’t see the full org forms list.</div>
        </div>

        {inspErr && <div className="text-red-600">{inspErr}</div>}
        {inspInfo && <div className="text-green-700">{inspInfo}</div>}

        {/* Quick create ad-hoc inspection */}
        <form onSubmit={createInspection} className="grid md:grid-cols-4 gap-2">
          <label className="text-sm md:col-span-2">Title
            <input className="border p-2 w-full" value={inspForm.title} onChange={(e)=>setInspForm({...inspForm,title:e.target.value})} required />
          </label>
          <label className="text-sm">Status
            <select className="border p-2 w-full" value={inspForm.status} onChange={(e)=>setInspForm({...inspForm,status:e.target.value})}>
              <option value="planned">planned</option><option value="open">open</option><option value="closed">closed</option>
            </select>
          </label>
          <label className="text-sm">Scheduled
            <input className="border p-2 w-full" type="datetime-local" value={inspForm.scheduledAt} onChange={(e)=>setInspForm({...inspForm,scheduledAt:e.target.value})}/>
          </label>
          <label className="text-sm md:col-span-3">Assignee
            <select className="border p-2 w-full" value={inspForm.assignee} onChange={(e)=>setInspForm({...inspForm,assignee:e.target.value})}>
              <option value="">— none —</option>
              {users.map(u=> <option key={u._id} value={String(u._id)}>{u.name||u.email||u.username}</option>)}
            </select>
          </label>
          <div className="md:col-span-1 flex items-end"><button className="px-3 py-2 border rounded w-full">Create</button></div>
        </form>

        <table className="w-full border text-sm">
          <thead><tr className="bg-gray-50"><th className="border p-2 text-left">Title</th><th className="border p-2 text-left">Status</th><th className="border p-2 text-left">Scheduled</th><th className="border p-2 text-left">Assignee</th><th className="border p-2 text-right">Actions</th></tr></thead>
          <tbody>
            {inspections.map(ins=>(
              <tr key={ins._id} className={ins.deletedAt?"opacity-60":""}>
                <td className="border p-2">
                  <span className="underline">{ins.title}</span>
                  {ins.deletedAt && <div className="text-xs text-red-700">deleted {new Date(ins.deletedAt).toLocaleString()}</div>}
                </td>
                <td className="border p-2">
                  <select className="border p-1" value={ins.status||"planned"} onChange={(e)=>updateInspectionStatus(ins._id,e.target.value)} disabled={!!ins.deletedAt}>
                    <option value="planned">planned</option><option value="open">open</option><option value="closed">closed</option>
                  </select>
                </td>
                <td className="border p-2"><div className="text-xs">{resolveWhen(ins)}</div></td>
                <td className="border p-2"><div className="text-xs">{resolveAssigneeName(ins)}</div></td>
                <td className="border p-2 text-right">
                  {!ins.deletedAt
                    ? <button className="px-2 py-1 border rounded" onClick={()=>deleteInspection(ins._id)}>Delete</button>
                    : <button className="px-2 py-1 border rounded" onClick={()=>restoreInspection(ins._id)}>Restore</button>}
                </td>
              </tr>
            ))}
            {!inspections.length && (<tr><td className="p-4 text-center" colSpan={5}>No inspections for this project.</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
