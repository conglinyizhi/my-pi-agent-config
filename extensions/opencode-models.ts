/**
 * OpenCode Models Extension for pi
 *
 * Reads the OpenCode API key from ~/.local/share/opencode/auth.json,
 * discovers available opencode/ models via the `opencode` CLI, and registers
 * them as a pi provider named `opencode`.
 *
 * Switch models with: /model-more opencode:<model-id>
 * Or run /model-more without arguments to open an interactive TUI selector.
 */

import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderConfig,
  type ProviderModelConfig,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const OPENCODE_BIN_CANDIDATES = [process.env.OPENCODE_BIN, `${HOME}/.opencode/bin/opencode`, "/usr/local/bin/opencode", "/usr/bin/opencode"];
const AUTH_PATH = `${HOME}/.local/share/opencode/auth.json`;
const PROVIDER_ID = "opencode";

type NewType = {
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
    input: NewType;
    output: NewType;
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
  try {
    const raw = readFileSync(AUTH_PATH, "utf8");
    const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
    return auth.opencode?.key;
  } catch {
    return undefined;
  }
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
      // ignore malformed entries
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

function discoverOpencodeModels(bin: string): OpencodeModel[] {
  try {
    const output = execSync(`"${bin}" models ${PROVIDER_ID} --verbose`, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return parseOpencodeModels(output);
  } catch {
    return [];
  }
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

async function saveDefaultModel(cwd: string, provider: string, modelId: string): Promise<void> {
  const settings = SettingsManager.create(cwd, getAgentDir());
  settings.setDefaultModelAndProvider(provider, modelId);
  await settings.flush();
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

export default function opencodeModelsExtension(pi: ExtensionAPI) {
  const apiKey = readOpencodeKey();
  const bin = findOpencodeBin();

  if (!apiKey) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(`OpenCode key not found in ${AUTH_PATH}. Run \`opencode providers login\`.`, "warning");
    });
    return;
  }

  if (!bin) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("OpenCode CLI not found. Set OPENCODE_BIN or add opencode to PATH.", "warning");
    });
    return;
  }

  const models = discoverOpencodeModels(bin);

  if (models.length === 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Failed to discover OpenCode models. Try `opencode models opencode --verbose`.", "warning");
    });
    return;
  }

  pi.registerProvider(PROVIDER_ID, buildProviderConfig(apiKey, models));

  const modelMap = new Map(models.map((m) => [m.id, m]));

  pi.registerCommand("model-more", {
    description: "Switch to an OpenCode model (opencode:<model-id>)",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.replace(/^opencode:/, "");
      const matches = models
        .filter((m) => m.id.startsWith(normalized) || `opencode:${m.id}`.startsWith(prefix))
        .map((m) => ({
          value: `opencode:${m.id}`,
          label: `${m.name} (${m.api.npm})`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      let modelId: string;
      let saveAsDefault = false;

      const trimmed = args.trim();
      if (!trimmed) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Interactive selector requires a TUI. Usage: /model-more opencode:<model-id>", "warning");
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
        ctx.ui.notify(`Unknown OpenCode model: ${modelId}`, "error");
        return;
      }

      const model = ctx.modelRegistry.find(PROVIDER_ID, modelId);
      if (!model) {
        ctx.ui.notify(`OpenCode model ${modelId} is not registered.`, "error");
        return;
      }

      if (saveAsDefault) {
        try {
          await saveDefaultModel(ctx.cwd, PROVIDER_ID, modelId);
        } catch (err) {
          ctx.ui.notify(`模型已切换，但保存默认设置失败：${err instanceof Error ? err.message : String(err)}`, "warning");
        }
      }

      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui.notify(`Failed to activate ${modelId} (API key issue?)`, "error");
        return;
      }

      const savedHint = saveAsDefault ? "，已保存为默认模型" : "";
      ctx.ui.notify(`已切换至 ${meta.name}（opencode:${modelId}）${savedHint}`, "info");
    },
  });
}
