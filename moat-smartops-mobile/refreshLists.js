// moat-smartops-mobile/refreshLists.js
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiGet } from "./apiClient";

export const CACHE_PROJECTS = "@moat:cache:projects";
export const CACHE_TASKS = "@moat:cache:tasks";
export const CACHE_MILESTONES = "@moat:cache:milestones";
export const CACHE_USERS = "@moat:cache:users";
export const CACHE_LAST_REFRESH = "@moat:cache:lastRefresh";

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Fetch lists from backend and cache for offline dropdowns.
 * Expected backend response:
 *  {
 *    projects: [...],
 *    tasks: [...],
 *    milestones: [...],   // or taskMilestones
 *    users: [...]
 *  }
 */
export async function refreshListsFromServer() {
  // IMPORTANT: endpoint must exist on backend:
  // GET /api/mobile/lists
  const data = await apiGet("/api/mobile/lists");

  const projects = safeArray(data?.projects);
  const tasks = safeArray(data?.tasks);
  const milestones = safeArray(data?.milestones || data?.taskMilestones);
  const users = safeArray(data?.users);

  await AsyncStorage.multiSet([
    [CACHE_PROJECTS, JSON.stringify(projects)],
    [CACHE_TASKS, JSON.stringify(tasks)],
    [CACHE_MILESTONES, JSON.stringify(milestones)],
    [CACHE_USERS, JSON.stringify(users)],
    [CACHE_LAST_REFRESH, new Date().toISOString()],
  ]);

  return {
    projectsCount: projects.length,
    tasksCount: tasks.length,
    milestonesCount: milestones.length,
    usersCount: users.length,
  };
}

export async function loadCachedLists() {
  const kv = await AsyncStorage.multiGet([
    CACHE_PROJECTS,
    CACHE_TASKS,
    CACHE_MILESTONES,
    CACHE_USERS,
    CACHE_LAST_REFRESH,
  ]);

  const map = Object.fromEntries(kv);

  const parse = (s, fallback) => {
    try {
      return JSON.parse(s || "");
    } catch {
      return fallback;
    }
  };

  return {
    projects: parse(map[CACHE_PROJECTS], []),
    tasks: parse(map[CACHE_TASKS], []),
    milestones: parse(map[CACHE_MILESTONES], []),
    users: parse(map[CACHE_USERS], []),
    lastRefresh: map[CACHE_LAST_REFRESH] || null,
  };
}
