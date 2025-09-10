import React, { useEffect, useState } from "react";
import { getProjects } from "../api";

export default function Dashboard() {
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    getProjects().then(setProjects).catch(console.error);
  }, []);

  return (
    <div style={{ padding: "2rem" }}>
      <h1>MOAT-SmartOps Dashboard 🚀</h1>
      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p._id}>
              {p.name} – {p.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
