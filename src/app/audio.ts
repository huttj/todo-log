// Global playback speed — one persisted setting shared by every player.
const KEY = "todolog.speed";
export const SPEEDS = [1, 1.25, 1.5, 2];

export function getSpeed(): number {
  const v = Number(localStorage.getItem(KEY));
  return SPEEDS.includes(v) ? v : 1;
}

export function setGlobalSpeed(v: number) {
  localStorage.setItem(KEY, String(v));
}

export function nextSpeed(current: number): number {
  return SPEEDS[(SPEEDS.indexOf(current) + 1) % SPEEDS.length];
}
