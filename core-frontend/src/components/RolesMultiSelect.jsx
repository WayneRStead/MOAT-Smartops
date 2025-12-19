// core-frontend/src/components/RolesMultiSelect.jsx
import { useEffect, useMemo, useRef, useState } from 'react';

function useOnClickOutside(ref, handler){
  useEffect(() => {
    const listener = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      handler(e);
    };
    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}

export default function RolesMultiSelect({ options = [], value = [], onChange, placeholder = 'Any role' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef(null);
  useOnClickOutside(boxRef, () => setOpen(false));

  const selected = new Set(value || []);
  const toggle = (role) => {
    const next = new Set(selected);
    next.has(role) ? next.delete(role) : next.add(role);
    onChange?.(Array.from(next));
  };
  const clearAll = () => onChange?.([]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return (options || []).filter((r) => String(r).toLowerCase().includes(needle));
  }, [options, q]);

  const summary = useMemo(() => {
    if (!selected.size) return placeholder;
    const arr = Array.from(selected);
    return arr.length === 1 ? arr[0] : `${arr[0]} +${arr.length - 1}`;
  }, [selected, placeholder]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        className="btn btn-outline w-full justify-between"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={selected.size ? '' : 'text-gray-400'}>{summary}</span>
        <svg className="h-4 w-4 opacity-60" viewBox="0 0 20 20" fill="currentColor"><path d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" /></svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-full rounded-xl border bg-white shadow-lg p-2">
          <div className="flex items-center gap-2 mb-2">
            <input
              className="input input-bordered input-sm w-full"
              placeholder="Search roles…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="button" className="btn btn-ghost btn-xs" onClick={clearAll}>
              Clear
            </button>
          </div>

          <div className="max-h-56 overflow-auto pr-1">
            {(filtered || []).map((role) => (
              <label key={role} className="flex items-center justify-between px-2 py-1 rounded hover:bg-gray-50 cursor-pointer">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={selected.has(role)}
                    onChange={() => toggle(role)}
                  />
                  <span className="text-sm">{role}</span>
                </div>
              </label>
            ))}
            {!filtered?.length && <div className="px-2 py-4 text-sm text-gray-500">No roles found</div>}
          </div>

          {!!selected.size && (
            <div className="mt-2 flex flex-wrap gap-2 px-1">
              {Array.from(selected).map((r) => (
                <span key={r} className="badge badge-outline gap-1">
                  {r}
                  <button type="button" className="ml-1" onClick={() => toggle(r)}>✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
