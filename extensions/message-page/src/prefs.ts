import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface LastModel {
  provider: string;
  id: string;
}

/** 本机偏好：记录上次选择的模型，避免每次重新挑。不属于会话，gitignore。 */
const FILE = join(homedir(), ".pi", "agent", "message-page-model.toml");

export async function readLastModel(): Promise<LastModel | undefined> {
  try {
    const content = await readFile(FILE, "utf8");
    const obj = parse(content) as { model?: { provider?: unknown; id?: unknown } };
    const m = obj?.model;
    if (m && typeof m.provider === "string" && typeof m.id === "string") {
      return { provider: m.provider, id: m.id };
    }
  } catch {
    // 文件不存在或解析失败 → 当作没有记录
  }
  return undefined;
}

export async function writeLastModel(provider: string, id: string): Promise<void> {
  try {
    const data = stringify({ model: { provider, id } });
    await writeFile(FILE, data, "utf8");
  } catch {
    // 写失败不应让命令挂掉
  }
}
