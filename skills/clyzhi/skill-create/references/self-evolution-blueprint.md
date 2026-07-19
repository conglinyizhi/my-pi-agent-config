# 技能自我进化机制设计

> 基于 Hermes Agent Self-Evolution（NousResearch/hermes-agent-self-evolution，MIT）
> Copyright (c) 2025 Nous Research — MIT License

---

## 概览

技能自我进化是一个**离线优化流水线**，用进化算法自动改进已有技能文件（SKILL.md），产出一个在真实任务上表现更优的版本。无需 GPU 训练，完全通过 API 调用完成——变异文本、评估结果、选择最优变体。

```
读取现有技能 ──► 生成评估数据集
                    │
                    ▼
               GEPA 优化器 ◄── 执行轨迹（理解为什么失败）
                    │              ▲
                    ▼              │
               候选变体 ──────► 评估（LLM-as-Judge 三维打分）
                    │
               硬约束门（大小/增长/结构/测试套件）
                    │
                    ▼
               最优变体 ──► 对比基线 → 输出
```

---

## 核心引擎：GEPA

GEPA（Genetic-Pareto Prompt Evolution）是 DSPy 生态中的进化优化器。它的关键优势：

- **不是"对/错"二元判断**：它读取执行轨迹，理解**为什么**失败
- **少样本友好**：3 个示例即可工作
- **Pareto 选择**：在正确性和简洁性之间多目标优化

备选引擎：DSPy MIPROv2（贝叶斯优化），GEPA 不可用时的降级方案。

---

## 三源评估数据

| 来源 | 说明 | 实现 |
|------|------|------|
| 合成数据 | 让 LLM 读技能文本，生成 (输入, 期望行为, 难度, 类别) 四元组 | `SyntheticDatasetBuilder` |
| 会话挖掘 | 从 Claude Code / Copilot / Hermes 历史中提取真实使用案例 | `external_importers.py` |
| 黄金集 | 手工标注的 JSONL 文件 | `GoldenDatasetLoader` |

自动按 50%/25%/25% 拆分为 train/val/holdout。

---

## 适应度评估（LLM-as-Judge）

每个候选变体在三维度上被打分（0–1）：

| 维度 | 权重 | 说明 |
|------|------|------|
| correctness | 0.5 | 是否正确完成任务？ |
| procedure_following | 0.3 | 是否遵循技能的步骤/流程？ |
| conciseness | 0.2 | 是否简洁而不遗漏关键信息？ |

额外的长度惩罚：当变体超过基线的 90% 时按比例扣分（最多扣 0.3）。

---

## 硬约束门

候选变体必须 **全部通过** 以下五项才能视为有效：

| 约束 | 阈值 |
|------|------|
| 大小限制 | ≤ 15,000 字符 |
| 增长限制 | 相对基线增长 ≤ 20% |
| 非空检查 | 不能产生空技能 |
| 结构完整性 | 合法 YAML 表头（name + description） |
| 测试套件 | 全量 pytest 全绿 |

---

## 集成方式

自我进化仓库作为独立项目运行，**不对 agent 运行时产生开销**：

```bash
git clone https://github.com/NousResearch/hermes-agent-self-evolution.git
cd hermes-agent-self-evolution
pip install -e ".[dev]"

# 指定目标技能仓库（pi/agent）
export HERMES_AGENT_REPO=/home/user/.pi/agent

# 进化一个技能
python -m evolution.skills.evolve_skill \
    --skill <skill-name> \
    --iterations 10 \
    --eval-source synthetic
```

输出写入 `output/<skill-name>/<timestamp>/`，包含：
- `evolved_skill.md` — 进化后的技能
- `baseline_skill.md` — 原始技能（对照）
- `metrics.json` — 完整指标记录

---

## 核心依赖

```
dspy       — 斯坦福提示词优化框架
gepa       — 遗传-Pareto 提示词进化（ICLR 2026 Oral）
yaml       — YAML 解析
click      — CLI 接口
rich       — 终端输出美化
```

---

## 原始出处

```
MIT License
Copyright (c) 2025 Nous Research
https://github.com/NousResearch/hermes-agent-self-evolution
```
