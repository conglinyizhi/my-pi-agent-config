/** 标记被 venv 保护的 pip install 切片为安全。 */
export function pipAfterVenv(slices: string[]): Set<number> {
  const safe = new Set<number>();
  let venvActive = false;
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    if (/\b(uv\s+venv|source\s+\S*venv\S*\/bin\/activate|python3?\s+-m\s+venv)\b/.test(s)) {
      venvActive = true;
      safe.add(i);
      continue;
    }
    if (venvActive && /\b(uv\s+pip\s+install|pip3?\s+install)\b/.test(s)) {
      safe.add(i);
    }
  }
  return safe;
}
