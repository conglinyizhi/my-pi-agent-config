// random-filler.ts — 高熵随机填充：往「模型卡在循环里」的消息里塞一段噪声
//
// 背景：有模型会在思维链阶段疯狂打转（cot 里反复循环出不来）。实测在注入的消息
// 里附一段很长的高熵随机中英混合文本，能把它拽回正常输出。本模块只负责「生成
// 这段噪声」，怎么摆放由下游决定：
//   - lib/continuation-message.ts：业务文本 + 恰好一个空行 + 填充
//   - extensions/loop-guard：嵌进 <random-trash-word> 元素
//
// 两条设计约束（从原实现原样搬过来，改之前先读）：
//
//   1. 填充必须每次重新生成。固定串会被模型记住并当作已知噪声忽略，随机串才有
//      足够的意外性去打断循环。所以本模块只提供生成器，不导出任何成品填充串。
//
//   2. 用词池而不是随机码位：从 CJK 区随机取码位会落到生僻字甚至未分配区，
//      部分 tokenizer 会退化成字节回退，既多烧 token 又可能渲染成方块。词池
//      同样是高熵随机文本，但每个字都是合法常用字，纯函数、可测。
//
// 词池刻意跨互不相关的语义域（天气/厨具/几何/乐器/交通/颜色/文书…），避免随机串
// 意外拼出一句「像指令」的话——填充一旦被模型当提示解读，就起了反作用。

/** 缺省填充长度（字符）。越长打断越强，token 成本越高；这是唯一需要调参的地方 */
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
export function generateRandomFiller(opts: FillerOptions = {}): string {
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
