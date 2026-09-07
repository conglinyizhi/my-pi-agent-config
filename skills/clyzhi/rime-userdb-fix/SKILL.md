---
name: rime-userdb-fix
description: 编辑 Rime 输入法时使用的参考资料与踩坑记录，便于后续查询
---

# Rime 动态词库：错词修正与候选排序调整

Rime 的自造词（误选候选被记下的）存在用户 LevelDB 动态词库 `*.userdb/` 里。两类常见调整：
- **修正记错的词**：某个词被记错，输入该拼音持续优先出错误词 → 改 key 里的词条文本。
- **调整候选排序**：某个音下"对的字"排不过其他候选 → 改 value 里的权重 `d`。

## 适用场景

- 用户反馈：输入某拼音时出来的词不对（记错的自造词）。
- 用户反馈：输入某拼音时想要的字排在后面（如同音候选排序不对）。

## 一、定位动态词库

生效词库（真正被 fcitx5-rime 读取）：
- `~/.local/share/fcitx5/rime/<schema>.userdb/` — LevelDB 目录（schema 示例：`rime_mint`）

同步导出文本（多设备同步用，也需改，否则下次同步把错误词导回）：
- `~/.local/share/fcitx5/rime/sync/<user_id>/<schema>.userdb.txt`

不要动：`build/`（编译产物）、`dicts/`、`opencc/` 里的同名字符串（如拆字部件、独立词「满月井」）—— 它们不是动态词。

## 二、前置条件与安全

1. **先停 fcitx5**：运行时锁定 LevelDB，直接打开报 `LOCK: Permission denied`
   ```bash
   fcitx5-remote -e && sleep 2   # 确认 pgrep fcitx5 为空
   ```
2. **先备份** userdb 目录 + sync 文本（改 LevelDB 有损坏风险，拷到临时目录）
3. **装 plyvel**（LevelDB Python 绑定，读改所需），用 uv 装到临时 venv；注意 uv 缓存/解释器目录可能被沙箱外写拦截，需要放开对应路径权限
4. 动手前与用户确认：停输入法期间打字中断，且动的是全部自造词库

## 三、记录结构（关键踩坑点）

LevelDB 每条记录：
- **key** = `拼音<TAB>词条`，明文 UTF-8，且拼音**带声调**（如 `jǐng`、`dào`）。**词条在 key 里，不在 value 里**
- **value** = `c=<次数> d=<权重> t=<tick>`。其中 `d` 是**排序权重**——在同一拼音的多个候选里，`d` 越大排越前；`c` 是被选中次数

因此：
- 搜词条要在 **key** 里搜，别在 value 里搜
- 匹配拼音要用带声调形式（`jǐng`/`dào`），不要用纯 ASCII `jing`/`dao`

## 四、修正记错的词（改 key 文本，保留权重）

用 plyvel `write_batch()` 删旧 key、写新 key，value 原样沿用（保 c/d/t）：

```python
import plyvel, os
path = os.path.expanduser("~/.local/share/fcitx5/rime/rime_mint.userdb")
db = plyvel.DB(path, create_if_missing=False)
targets = [(k, v) for k, v in db
           if "月警之春" in k.decode("utf-8", errors="replace")]  # key 含完整错误词
db.close()

db = plyvel.DB(path, create_if_missing=False)
wb = db.write_batch()
for k, v in targets:
    new = k.replace("警".encode("utf-8"), "井".encode("utf-8"))   # 只换目标字字节
    wb.delete(k)
    wb.put(new, v)
wb.write()
db.close()
```

要点：
- 只对含**完整错误词**（如 `月警之春`）的 key 操作，别误伤同拼音下其他候选（如「月井」单字）
- 用 WriteBatch 原子替换；不要手工改二进制

## 五、调整候选排序（改 value 的 `d`，不动 key）

**先诊断根因**：同一拼音下的候选，先看各自 userdb 的 `d` 值。静态词频高不代表运行时排前——动态记忆会反超。

例：输入 `dao`，用户反馈「到」排在「刀」和 emoji 后面。
- 查得 `dào \t到` = `c=106 d=6.80`，`dāo \t刀` = `c=147 d=8.89` → 用户高频用「刀」（c=147），把「刀」的 `d` 顶到 8.89，反超了「到」的 6.80。
- emoji 🔪 是 OpenCC 给「刀」绑的（`opencc/emoji.txt: 刀 → 刀 🔪`），跟随主词「刀」排前。**要压过 emoji，只需让目标词超过它的主词**，别去改 opencc 文件。

**改法**：把目标词条的 value 里 `d` 值拉高，超过对手（保留 c/t）：

```python
import plyvel, os, re
path = os.path.expanduser("~/.local/share/fcitx5/rime/rime_mint.userdb")
TARGET = "dào \t到"   # 精确 key（带声调）
db = plyvel.DB(path, create_if_missing=False)
found = [(k, v) for k, v in db if k.decode("utf-8", errors="replace") == TARGET]
db.close()

db = plyvel.DB(path, create_if_missing=False)
wb = db.write_batch()
for k, v in found:
    new_v = re.sub(r"d=[0-9.eE+\-]+", "d=12", v.decode("utf-8"))  # 拉到远超对手
    wb.put(k, new_v.encode("utf-8"))
wb.write()
db.close()
```

要点：
- **精确匹配 key**（`dào \t到`），只改目标词，别动同音其他候选（到处/刀叉…）
- **只改 value 里的 `d`**，保留 `c`/`t`；用正则 `d=[0-9.eE+\-]+` 替换
- 拉到**明显超过对手**（例：到 d=8.89 的刀改为 d=12），留裕度，别只超一点点
- 这是**一次性**调整：用户若继续高频用对手词，其 `c` 涨上去可能再次反超。想要长期稳定，见下文验证/提示。

## 六、同步文本同步修正

两类改动都需同步 `sync/.../<schema>.userdb.txt`，否则下次同步把旧状态导回：

```bash
# 改词条文本
sed -i 's/月警之春/月井之春/g' \
  ~/.local/share/fcitx5/rime/sync/<user_id>/rime_mint.userdb.txt
```

注：调 `d` 权重这类也可能被同步覆盖，若用户启用同步，同样对该文件里对应行的 `d=` 值做一致修正（或整体重新导出）。

## 七、验证

1. 改后重新打开 LevelDB：确认达到预期（错误词消失 / 目标词 `d` 已超过对手）
2. 重启 fcitx5（`fcitx5 -d`），日志应见 `Loaded addon rime`，无 userdb 报错
3. 注意：**数据层确认 ≠ 候选排序确认**，需提示用户实际输入一遍落点
4. 调排序类改动，收工时要说明这是**一次性动态调整**，并提示长期方案（在 rime 候选里删除对手词记忆，或把权重抬得更高）

## 八、回滚

改前备份置于临时目录；确认无误后可删除，有问题可整目录还原。
