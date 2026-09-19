export function pairLabel(pair) {
  if (!pair) return "";
  const name = (pair.displayName || "").trim() || pair.userId || "";
  const channel = pair.channel || "";
  if (channel && name) return `${channel} / ${name}`;
  return channel || name || pair.code || "";
}
