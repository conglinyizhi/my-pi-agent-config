/**
 * OpenCode 模型扩展
 *
 * 从 ~/.local/share/opencode/auth.json 读取 OpenCode API 密钥，
 * 通过 opencode CLI 发现可用的 opencode/ 模型，并将其注册为名为 opencode 的 pi provider。
 *
 * 使用 /model-more opencode:<model-id> 切换模型，
 * 或直接运行 /model-more 打开交互式 TUI 选择器。
 */

import { exec, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ProviderConfig,
  type ProviderModelConfig,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { loadAuthJsonPath } from "../lib/auth.ts";

const HOME = homedir();
const OPENCODE_BIN_CANDIDATES = [process.env.OPENCODE_BIN, `${HOME}/.opencode/bin/opencode`, "/usr/local/bin/opencode", "/usr/bin/opencode"];
const AUTH_PATH = `${HOME}/.local/share/opencode/auth.json`;
const PROVIDER_ID = "opencode";

type MediaCapabilities = {
  text: boolean;
  image: boolean;
  audio: boolean;
  video: boolean;
  pdf: boolean;
};

interface OpencodeModel {
  id: string;
  providerID: string;
  name: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  capabilities: {
    reasoning: boolean;
    input: MediaCapabilities;
    output: MediaCapabilities;
  };
  limit: {
    context: number;
    output: number;
    input?: number;
  };
  cost: {
    input: number;
    output: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

interface ModelSelection {
  modelId: string;
  saveAsDefault: boolean;
}

function findOpencodeBin(): string | undefined {
  for (const candidate of OPENCODE_BIN_CANDIDATES) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    return execSync("command -v opencode", { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readOpencodeKey(): string | undefined {
  const auth = loadAuthJsonPath(AUTH_PATH);
  return auth.opencode?.key;
}

function parseOpencodeModels(output: string): OpencodeModel[] {
  const models: OpencodeModel[] = [];
  const lines = output.split(/\r?\n/);
  let currentId: string | null = null;
  let jsonBuffer: string[] = [];

  const flush = () => {
    if (!currentId || jsonBuffer.length === 0) return;
    try {
      const parsed = JSON.parse(jsonBuffer.join("\n")) as OpencodeModel;
      if (parsed.providerID === PROVIDER_ID) {
        models.push(parsed);
      }
    } catch {
      // 忽略格式错误的条目
    }
  };

  for (const line of lines) {
    if (line.startsWith(`${PROVIDER_ID}/`)) {
      flush();
      currentId = line;
      jsonBuffer = [];
    } else if (currentId !== null) {
      jsonBuffer.push(line);
    }
  }
  flush();

  return models;
}

async function discoverOpencodeModelsAsync(bin: string): Promise<OpencodeModel[]> {
  return new Promise((resolve) => {
    exec(`"${bin}" models ${PROVIDER_ID} --verbose`, { encoding: "utf8", timeout: 15000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(parseOpencodeModels(stdout));
    });
  });
}

function mapApiType(npmPackage: string): ProviderModelConfig["api"] {
  switch (npmPackage) {
    case "@ai-sdk/anthropic":
      return "anthropic-messages";
    case "@ai-sdk/google":
      return "google-generative-ai";
    default:
      return "openai-completions";
  }
}

function buildProviderConfig(apiKey: string, models: OpencodeModel[]): ProviderConfig {
  const firstUrl = models[0]?.api.url ?? "https://opencode.ai/zen/v1";

  return {
    name: "OpenCode",
    baseUrl: firstUrl,
    apiKey,
    authHeader: true,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      api: mapApiType(m.api.npm),
      reasoning: m.capabilities.reasoning,
      input: [...(m.capabilities.input.text ? (["text"] as const) : []), ...(m.capabilities.input.image ? (["image"] as const) : [])],
      cost: {
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cache.read,
        cacheWrite: m.cost.cache.write,
      },
      contextWindow: m.limit.context,
      maxTokens: m.limit.output,
    })),
  };
}

function buildSelectList(items: SelectItem[], theme: Theme): SelectList {
  const list = new SelectList(items, Math.min(items.length, 12), {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });
  return list;
}

class SearchableModelSelector implements Component, Focusable {
  private allItems: SelectItem[];
  private filteredItems: SelectItem[];
  private searchInput: Input;
  private selectList: SelectList;
  private container: Container;
  private theme: Theme;
  private onDone: (value: string | null) => void;
  private cachedLines?: string[];
  private cachedWidth?: number;
  focused: boolean = false;

  constructor(items: SelectItem[], onDone: (value: string | null) => void, theme: Theme) {
    this.allItems = items;
    this.filteredItems = items;
    this.onDone = onDone;
    this.theme = theme;

    this.searchInput = new Input();
    this.searchInput.onEscape = () => onDone(null);

    this.selectList = buildSelectList(items, theme);
    this.selectList.onSelect = (item) => onDone(item.value);
    this.selectList.onCancel = () => onDone(null);

    this.container = new Container();
    this.container.addChild(new Text(theme.fg("accent", theme.bold("选择 OpenCode 模型")), 1, 0));
    this.container.addChild(new Text(theme.fg("dim", "输入文字过滤模型 • ↑↓ 移动 • 回车确认 • Esc 取消"), 1, 0));
  }

  private updateFilter() {
    const query = this.searchInput.getValue();
    if (!query) {
      this.filteredItems = this.allItems;
    } else {
      this.filteredItems = fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase());
    }
    this.selectList = buildSelectList(this.filteredItems, this.theme);
    this.selectList.onSelect = (item) => this.onDone(item.value);
    this.selectList.onCancel = () => this.onDone(null);
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      this.selectList.handleInput(data);
      this.cachedLines = undefined;
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.selectList.handleInput(data);
    } else if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onDone(null);
    } else {
      const before = this.searchInput.getValue();
      this.searchInput.handleInput(data);
      if (this.searchInput.getValue() !== before) {
        this.updateFilter();
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    lines.push(...this.container.render(width));
    lines.push("");
    lines.push(...this.searchInput.render(width));
    lines.push("");

    if (this.filteredItems.length === 0) {
      lines.push(this.theme.fg("warning", "  没有匹配的模型"));
    } else {
      lines.push(...this.selectList.render(width));
    }

    this.cachedLines = lines.map((line) => truncateToWidth(line, width));
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
    this.container.invalidate();
    this.searchInput.invalidate();
    this.selectList.invalidate();
  }
}

async function confirmSaveDefault(ctx: ExtensionContext, modelId: string, modelName: string): Promise<"yes" | "no" | "cancel"> {
  const title = `已选择模型：opencode:${modelId}（${modelName}）\n是否将其设为默认模型并写入 settings.json？`;
  const options = ["是 - 保存为默认模型并切换", "否 - 仅切换当前会话", "取消 - 放弃选择"];
  const selected = await ctx.ui.select(title, options);
  if (selected === options[0]) return "yes";
  if (selected === options[1]) return "no";
  return "cancel";
}

const SETTINGS_PATH = `${getAgentDir()}/settings.json`;

async function saveDefaultModelPreservingFormat(provider: string, modelId: string): Promise<void> {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  // 仅替换 defaultProvider 和 defaultModel 的值，保留文件其余格式、缩进与注释。
  let updated = raw;
  updated = updated.replace(/("defaultProvider"\s*:\s*)"[^"]*"/, `$1"${provider}"`);
  updated = updated.replace(/("defaultModel"\s*:\s*)"[^"]*"/, `$1"${modelId}"`);

  // 如果正则未命中（键不存在或格式异常），回退到 SettingsManager。
  if (updated === raw) {
    const settings = SettingsManager.create(".", getAgentDir());
    settings.setDefaultModelAndProvider(provider, modelId);
    await settings.flush();
    return;
  }

  writeFileSync(SETTINGS_PATH, updated, "utf8");
}

async function showModelSelector(ctx: ExtensionContext, models: OpencodeModel[]): Promise<ModelSelection | null> {
  const items: SelectItem[] = models.map((m) => ({
    value: m.id,
    label: `opencode:${m.id}`,
    description: `${m.name} • ${m.api.npm}`,
  }));

  const modelId = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
    const selector = new SearchableModelSelector(items, done, theme);
    return selector;
  });

  if (!modelId) return null;

  const meta = models.find((m) => m.id === modelId);
  if (!meta) return null;

  const choice = await confirmSaveDefault(ctx, modelId, meta.name);
  if (choice === "cancel") return null;

  return { modelId, saveAsDefault: choice === "yes" };
}

export default async function opencodeModelsExtension(pi: ExtensionAPI) {
  const apiKey = readOpencodeKey();
  const bin = findOpencodeBin();

  if (!apiKey) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(`未在 ${AUTH_PATH} 找到 OpenCode 密钥。请运行 \`opencode providers login\`。`, "warning");
    });
    return;
  }

  if (!bin) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("未找到 OpenCode CLI。请设置 OPENCODE_BIN 或将 opencode 加入 PATH。", "warning");
    });
    return;
  }

  // 立即开始异步加载模型，不阻塞扩展加载；/model-more 会等待该 Promise。
  const modelsPromise = discoverOpencodeModelsAsync(bin);

  // 在 session_start 中通过 ctx.modelRegistry 注册 provider（不依赖 pi 的活性）
  // 使用 .then() 异步注册，不 await modelsPromise，避免阻塞 /new 等会话创建流程
  pi.on("session_start", (_event, ctx) => {
    const registry = ctx.modelRegistry;
    const notify = ctx.ui.notify.bind(ctx.ui);

    modelsPromise.then((models) => {
      if (models.length === 0) {
        notify("获取 OpenCode 模型列表失败。请尝试运行 `opencode models opencode --verbose`。", "warning");
        return;
      }
      registry.registerProvider(PROVIDER_ID, buildProviderConfig(apiKey, models));
      notify(`已加载 ${models.length} 个 OpenCode 模型`, "info");
    });
  });

  pi.registerCommand("model-more", {
    description: "切换到 OpenCode 模型（opencode:<model-id>）",
    getArgumentCompletions: (_prefix) => {
      // 补全无法异步，模型尚未就绪时返回空。
      return null;
    },
    handler: async (args, ctx) => {
      ctx.ui.notify("正在加载 OpenCode 模型列表，请稍候...", "info");
      const models = await modelsPromise;

      if (models.length === 0) {
        ctx.ui.notify("未能获取 OpenCode 模型列表，请检查 opencode CLI 是否可用。", "error");
        return;
      }

      const modelMap = new Map(models.map((m) => [m.id, m]));
      let modelId: string;
      let saveAsDefault = false;

      const trimmed = args.trim();
      if (!trimmed) {
        if (!ctx.hasUI) {
          ctx.ui.notify("交互式选择器需要 TUI。用法：/model-more opencode:<model-id>", "warning");
          return;
        }
        const selection = await showModelSelector(ctx, models);
        if (!selection) return;
        modelId = selection.modelId;
        saveAsDefault = selection.saveAsDefault;
      } else {
        modelId = trimmed.replace(/^opencode:/, "").trim();
      }

      const meta = modelMap.get(modelId);
      if (!meta) {
        ctx.ui.notify(`未知 OpenCode 模型：${modelId}`, "error");
        return;
      }

      const model = ctx.modelRegistry.find(PROVIDER_ID, modelId);
      if (!model) {
        ctx.ui.notify(`OpenCode 模型 ${modelId} 尚未注册。`, "error");
        return;
      }

      if (saveAsDefault) {
        try {
          await saveDefaultModelPreservingFormat(PROVIDER_ID, modelId);
        } catch (err) {
          ctx.ui.notify(`模型已切换，但保存默认设置失败：${err instanceof Error ? err.message : String(err)}`, "warning");
        }
      }

      let success: boolean;
      try {
        success = await pi.setModel(model);
      } catch (err) {
        ctx.ui.notify(`模型切换失败：${err instanceof Error ? err.message : String(err)}。请执行 /reload 后重试。`, "error");
        return;
      }
      if (!success) {
        ctx.ui.notify(`激活 ${modelId} 失败（可能是 API 密钥问题）`, "error");
        return;
      }

      const savedHint = saveAsDefault ? "，已保存为默认模型" : "";
      ctx.ui.notify(`已切换至 ${meta.name}（opencode:${modelId}）${savedHint}`, "info");
    },
  });
}
