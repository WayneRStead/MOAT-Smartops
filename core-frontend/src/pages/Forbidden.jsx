// src/pages/Forbidden.jsx
import React from "react";
import { Link } from "react-router-dom";

export default function Forbidden() {
  return (
    <div className="p-10 flex flex-col items-center text-center space-y-6">
      <div className="text-6xl">🚫</div>
      <h1 className="text-2xl font-semibold text-red-600">Access Denied</h1>
      <p className="text-gray-700 max-w-md">
        You don’t have permission to view this page or the module is disabled
        for your organisation.
      </p>
      <Link
        to="/"
        className="px-4 py-2 bg-black text-white rounded hover:bg-gray-800 transition"
      >
        Back to Home
      </Link>
    </div>
  );
}
