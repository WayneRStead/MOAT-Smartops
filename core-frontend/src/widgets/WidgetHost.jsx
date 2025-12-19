import React from "react";
import { useFilterContext } from "./FilterContext";
import { getWidget } from "./registry";

/**
 * WidgetHost mounts a widget by id, wires it to global filters,
 * fetches data when relevant filters change, and passes an `emit` function.
 */
export default function WidgetHost({ widgetId, frame: FrameComponent, ...frameProps }) {
  const widget = getWidget(widgetId);
  const { filters, emit } = useFilterContext();

  const usedKeys = widget?.uses || []; // which filter keys this widget cares about
  const watched = usedKeys.length
    ? usedKeys.reduce((m, k) => ({ ...m, [k]: filters[k] }), {})
    : filters;

  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  const fetchRef = React.useRef(0);

  React.useEffect(() => {
    let alive = true;
    const token = ++fetchRef.current;

    async function run() {
      if (!widget?.fetch) {
        setData(null); setLoading(false); setError("");
        return;
      }
      setLoading(true); setError("");
      try {
        const result = await widget.fetch(filters);
        if (!alive || token !== fetchRef.current) return;
        setData(result?.data ?? result ?? null);
        setLoading(false);
      } catch (e) {
        if (!alive || token !== fetchRef.current) return;
        setError(e?.response?.data?.error || e?.message || String(e));
        setLoading(false);
      }
    }
    run();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(watched), widgetId]);

  if (!widget) return null;

  const body = widget.render
    ? widget.render({ data, filters, emit })
    : null;

  if (!FrameComponent) return body;

  return (
    <FrameComponent
      title={widget.title}
      loading={loading}
      error={error}
      {...frameProps}
    >
      {body}
    </FrameComponent>
  );
}
