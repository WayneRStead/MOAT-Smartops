// src/pages/NotFound.jsx
import React from "react";
import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="p-10 flex flex-col items-center text-center space-y-6">
      <div className="text-6xl">🔍</div>
      <h1 className="text-2xl font-semibold text-gray-800">Page Not Found</h1>
      <p className="text-gray-600 max-w-md">
        The page you’re looking for doesn’t exist or has been moved.
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
