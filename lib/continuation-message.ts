// continuation-message.ts — 续跑消息与自报完成哨兵：业务文本 + 「拉回理智」随机填充
//
// 背景：有模型会在思维链阶段疯狂打转（cot 里反复循环出不来）。实测在续跑消息
// 末尾附一段很长的高熵随机中英混合文本，能把它拽回正常输出。
//
// 三条设计约束：
//   1. 填充必须每次重新生成。固定串会被模型记住并当作已知噪声忽略，随机串才有足够的
//      意外性去打断循环。所以本模块只提供生成器，不导出任何成品填充串。
//   2. 与业务文本的分界固定为**恰好一个空行**（appendLoopBreaker）。前半是出口
//      指令（「真完成了就去调那个工具」），必须保持完整可读；后半是噪声。空行是
//      让模型自己分辨「这是有价值的信息 / 这是填充」的唯一信号，别退化成两句连排。
//   3. 出口指令文本与识别它的字符串（BASH_HIT）必须同源，且识别必须**精确且严格**：
//      消息里叫模型执行哪条命令，拦截侧就只能认那一条。早期用 `cmd.includes(BASH_HIT)`
//      子串匹配，任何正文里提到过这句的命令（跑一段含该字面量的脚本、grep 搜它、
//      heredoc 里贴着它）都会被当成「模型报完成」，进而 abort 掉正在进行的工作。
//      为此有了 isBashHitCommand：只认整条命令就是它（允许引号/尾分号/空白差异）。
//
// 为什么用词池而不是随机码位：从 CJK 区随机取码位会落到生僻字甚至未分配区，
// 部分 tokenizer 会退化成字节回退，既多烧 token 又可能渲染成方块。词池同样是
// 高熵随机文本，但每个字都是合法常用字，纯函数、可测。
//
// 词池刻意跨互不相关的语义域（天气/厨具/几何/乐器/交通/颜色/文书…），避免随机串
// 意外拼出一句「像指令」的话——填充一旦被模型当提示解读，就起了反作用。

/**
 * 续跑业务文本（出口指令）。末尾的 bash 出口是给「真完成了」的模型一条自报捷径：
 * 它一旦发现又收到这条消息，就调 bash 执行 BASH_HIT，父进程认这个信号直接收工。
 */
export const CONTINUE_PROMPT =
  "你似乎没有说完，我没有看到你的发言就终止了任务，请在content区域输出一些文本让我知道这个任务完成详情；如果你重复看到了这条消息，请调用 bash 工具：";

/** 自报完成的哨兵命令：既写在 CONTINUE_PROMPT 末尾，也被工具拦截侧匹配 */
export const BASH_HIT = "echo job done already";

/**
 * 这条 bash 命令是不是「模型在执行自报完成哨兵」。
 *
 * **只认整条命令就是哨兵本身**，不是「命令里出现了哨兵」。容忍的等价写法只有：
 * 首尾空白、内部连续空白、参数带引号、结尾一个分号。其余一律不算：
 *
 *   echo job done already                 → true
 *   echo "job done already"               → true
 *   echo 'job done already';              → true
 *   echo job done already && ls           → false（还有别的事要做）
 *   grep -r "echo job done already" .     → false（只是提到它）
 *   python3 - <<'PY' … 含该字面量 … PY    → false（正文里的字符串）
 *   echo job done already\nls             → false（多了第二条命令）
 */
export function isBashHitCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const collapsed = command.trim().replace(/\s+/g, " ");
  if (!collapsed) return false;
  const withoutSemicolon = collapsed.replace(/;\s*$/, "");
  // echo "job done already" / echo 'job done already' → 去引号后比对
  const unquoted = withoutSemicolon.replace(/^echo ("([^"]*)"|'([^']*)')$/, (_m, _raw, doubleQuoted, singleQuoted) =>
    `echo ${doubleQuoted ?? singleQuoted}`,
  );
  return unquoted === BASH_HIT;
}

/** 缺省填充长度（字符）。这是唯一需要调参的地方：越长打断越强，token 成本越高 */
export const DEFAULT_FILLER_CHARS = 4000;

/** 中文词池：跨无关语义域，故意不构成可解释语义 */
const ZH_WORDS: readonly string[] = [
  "河岸", "桂花", "铜壶", "瓦片", "纸鸢", "竹帘", "船坞", "苔痕", "雪粒", "灶台",
  "瓷碗", "草席", "砂砾", "井绳", "木履", "香灰", "皱褶", "铁轨", "海雾", "烛芯",
  "楔形", "钝角", "螺线", "曲面", "切片", "垂线", "环形", "直角", "褶皱", "旋涡",
  "琴弦", "鼓面", "笛孔", "哨片", "节拍", "余音", "低吟", "滑音", "休止", "和声",
  "站台", "渡口", "巷口", "环岛", "吊桥", "路肩", "匝道", "浮标", "桅杆", "缆绳",
  "赭石", "靛蓝", "米白", "藕荷", "黛青", "琥珀", "铅灰", "象牙", "栗棕", "藤黄",
  "誊抄", "批注", "草稿", "页码", "装订", "索引", "附注", "校样", "封皮", "宣纸",
  "茶渍", "盐粒", "梅子", "藕片", "面筋", "米汤", "酱色", "烫面", "凉粉", "酥皮",
  "苔原", "沙丘", "溶洞", "断崖", "潮线", "冻土", "碱滩", "石林", "峡湾", "火山",
  "钟摆", "齿条", "弹簧", "榫头", "垫圈", "轴瓦", "卡箍", "销钉", "铆钉", "衬套",
  "低语", "打盹", "踱步", "耸肩", "搓手", "眨眼", "叹口", "抿嘴", "点头", "驻足",
];

/** 英文词池：同样跨域，与中文池语义不重叠 */
const EN_WORDS: readonly string[] = [
  "lantern", "pebble", "trolley", "velvet", "harbor", "lichen", "apron", "cistern",
  "kettle", "thistle", "marble", "wicker", "gravel", "sundial", "paddle", "tundra",
  "hexagon", "tangent", "lattice", "spiral", "prism", "tangram", "vertex", "seam",
  "oboe", "timbre", "octave", "cadence", "refrain", "fret", "mute", "tempo",
  "tram", "jetty", "viaduct", "roundabout", "bollard", "gantry", "mooring", "ferry",
  "ochre", "indigo", "ivory", "amber", "mauve", "slate", "linen", "tangerine",
  "ledger", "margin", "footnote", "binding", "proof", "colophon", "folio", "index",
  "brine", "yeast", "saffron", "almond", "fennel", "sorrel", "molasses", "crouton",
  "delta", "marsh", "basalt", "moraine", "gully", "plateau", "estuary", "atoll",
  "pawl", "ratchet", "washer", "dowel", "ferrule", "bushing", "tappet", "gudgeon",
  "murmur", "dawdle", "stroll", "shrug", "wince", "gaze", "linger", "drift",
];

export interface FillerOptions {
  /** 目标字符数（默认 DEFAULT_FILLER_CHARS）；>= 目标即停，不切词 */
  chars?: number;
  /** 随机源（0..1），注入以便确定性测试；缺省 Math.random */
  random?: () => number;
}

/** 取 [0, length) 的整数下标；random 越界/非有限值都夹回合法范围 */
function pickIndex(length: number, random: () => number): number {
  if (length <= 0) return 0;
  const v = random();
  if (!Number.isFinite(v)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(v * length)));
}

/**
 * 生成一段高熵随机中英混合填充。
 *
 * 只追加**整词**直到达到目标长度，不做中途截断——半截英文词看着像乱码，
 * 反而可能被模型当成特殊标记
 */
export function generateContinuationFiller(opts: FillerOptions = {}): string {
  const target = Math.max(0, Math.floor(opts.chars ?? DEFAULT_FILLER_CHARS));
  if (target === 0) return "";
  const random = opts.random ?? Math.random;
  const words: string[] = [];
  let length = 0;
  while (length < target) {
    const zh = random() < 0.5;
    const word = zh
      ? ZH_WORDS[pickIndex(ZH_WORDS.length, random)]
      : EN_WORDS[pickIndex(EN_WORDS.length, random)];
    // 分隔空格只在词与词之间产生（N 词 N-1 个空格），首词不计——
    // 否则累计长度会比 join 结果多 1，目标字符数永远差一
    length += word.length + (words.length > 0 ? 1 : 0);
    words.push(word);
  }
  return words.join(" ");
}

/**
 * 业务文本 + 空行 + 填充。
 *
 * 分界契约就是这里的 `\n\n`：恰好一个空行。填充为空时原样返回 base，
 * 避免在不需要打断的路径上平白多出空行
 */
export function appendLoopBreaker(base: string, filler: string): string {
  if (!filler) return base;
  return `${base}\n\n${filler}`;
}

/**
 * 拼出最终续跑消息：业务文本（含 bash 出口）→ 恰好一个空行 → 高熵随机填充。
 *
 * 空行之后那段不传递信息，只用意外性把在思维链里打转的模型拽回来；
 * 留一个空行分界，是要让模型看得出「前半有价值、后半是填充」。
 * 填充缺省每次重新生成
 */
export function buildContinueMessage(filler: string = generateContinuationFiller()): string {
  return appendLoopBreaker(CONTINUE_PROMPT + BASH_HIT, filler);
}
