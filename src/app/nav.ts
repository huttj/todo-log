// Tracks the previous in-app path so back buttons can say where they lead.
export const navHistory = { prev: null as string | null, current: null as string | null };

export function trackPath(path: string) {
  if (navHistory.current === path) return;
  navHistory.prev = navHistory.current;
  navHistory.current = path;
}
