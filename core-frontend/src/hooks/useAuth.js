// src/hooks/useAuth.js
import { useEffect, useState } from "react";
import { getUser, whoAmI } from "../services/auth";

export function useAuth() {
  const [user, setUser] = useState(getUser());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await whoAmI(); // validates token on server
        // if the token is invalid, the axios interceptor should redirect to /signin
      } catch {
        // ignore; interceptor handles 401
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return { user, loading };
}
