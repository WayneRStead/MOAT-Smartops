import React from "react";
import { cn } from "../../lib/cn";

export function Page({ title, actions, className, children }) {
  return (
    <div className={cn("p-4 md:p-6 space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}
