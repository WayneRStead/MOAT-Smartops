// src/pages/AdminInspectionFormBuilder.jsx
import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  createInspectionTemplate,
  updateInspectionTemplate,
  getInspectionTemplate,
} from "../lib/inspectionsApi";

// Lazy-load the visual builder so this page renders even if the file is
// temporarily absent or being renamed.
function Loader({ value, onSave, onCancel }) {
  const [Comp, setComp] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let mounted = true;
    import("../components/InspectionFormBuilder.jsx")
      .then((m) => {
        if (!mounted) return;
        const C = m.default || m.InspectionFormBuilder || m;
        if (typeof C === "function") setComp(() => C);
        else setErr("InspectionFormBuilder export not found.");
      })
      .catch(() =>
        setErr(
          "InspectionFormBuilder component not found. Create src/components/InspectionFormBuilder.jsx or adjust the import."
        )
      );
    return () => {
      mounted = false;
    };
  }, []);

  if (err) return <div className="text-red-600">{err}</div>;
  if (!Comp) return <div className="text-gray-600">Loading form builder…</div>;
  // Pass the normalized object the builder expects.
  return <Comp value={value} onSave={onSave} onCancel={onCancel} />;
}

/** Builder <-> Template mapping helpers */
function toBuilderShape(tplRaw) {
  // unwrap wrappers just in case (some backends return {form:{...}} or {template:{...}})
  const tpl = tplRaw?.form || tplRaw?.template || tplRaw || {};
  return {
    _id: tpl._id || tpl.id,
    title: tpl.title || tpl.name || "",
    description: tpl.description || "",
    version: tpl.version ?? 1,
    fields: Array.isArray(tpl.schema) ? tpl.schema : Array.isArray(tpl.fields) ? tpl.fields : [],
    tags: tpl.tags || tpl.labels || [],
    category: tpl.category || tpl.type || "",
    status: tpl.status || (tpl.active === false ? "archived" : "active"),
    active: tpl.active ?? (String(tpl.status || "").toLowerCase() === "active"),
  };
}

function fromBuilderShape(v) {
  // Ensure we never send an empty title/name (prevents "Untitled form" in lists)
  const fallback = `Inspection Form ${new Date().toLocaleDateString()}`;
  const title = (v.title || v.name || "").trim() || fallback;

  const schemaArr =
    Array.isArray(v.schema) ? v.schema :
    Array.isArray(v.fields) ? v.fields :
    [];

  const tagsArr = Array.isArray(v.tags) ? v.tags : (Array.isArray(v.labels) ? v.labels : []);

  return {
    name: title,
    title,
    description: v.description || "",
    category: v.category || "",
    status: v.status || (v.active === false ? "archived" : "active"),
    active: v.active ?? (String(v.status || "").toLowerCase() === "active"),
    version: v.version ?? 1,

    // send schema in all common aliases; the inspectionsApi will also alias
    schema: schemaArr,
    fields: schemaArr,
    definition: schemaArr,
    form: schemaArr,

    tags: tagsArr,
    labels: tagsArr,
  };
}

export default function AdminInspectionFormBuilder({ mode }) {
  const navigate = useNavigate();
  const { formId } = useParams();
  const creating = (mode || "edit") === "create";

  const [form, setForm] = useState(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const title = creating ? "New Inspection Form" : "Edit Inspection Form";

  // Load existing template when editing; seed defaults when creating
  useEffect(() => {
    let mounted = true;
    (async () => {
      setErr("");
      if (creating) {
        setForm({
          title: "",
          description: "",
          version: 1,
          fields: [],
          tags: [],
          category: "",
          status: "active",
          active: true,
        });
        return;
      }
      try {
        const tpl = await getInspectionTemplate(formId);
        if (mounted) setForm(toBuilderShape(tpl));
      } catch (e) {
        if (!mounted) return;
        const msg =
          e?.response?.data?.error ||
          e?.response?.data?.message ||
          e?.message ||
          "Failed to load form";
        setErr(msg);
      }
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, formId]);

  async function handleSave(nextValue) {
    setErr("");
    setSaving(true);
    try {
      if (creating) {
        const created = await createInspectionTemplate(fromBuilderShape(nextValue));
        const newId =
          created?.id ||
          created?._id ||
          created?.form?.id ||
          created?.form?._id ||
          created?.template?.id ||
          created?.template?._id;
        if (newId) {
          navigate(`/admin/inspections/forms/${newId}`, { replace: true });
        } else {
          navigate("/admin/inspections/forms", { replace: true });
        }
      } else {
        await updateInspectionTemplate(formId, fromBuilderShape(nextValue));
        navigate("/admin/inspections/forms");
      }
    } catch (e) {
      const msg =
        e?.response?.data?.error ||
        e?.response?.data?.message ||
        e?.message ||
        "Save failed";
      setErr(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{title}</h1>
        <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {saving && <div className="text-gray-600">Saving…</div>}

      {form ? (
        <Loader
          value={form}
          onSave={handleSave}
          onCancel={() => navigate("/admin/inspections/forms")}
        />
      ) : (
        <div className="text-gray-600">Loading…</div>
      )}
    </div>
  );
}
