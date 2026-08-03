#!/usr/bin/env node
// 洗牌选择题选项顺序，重新分配 A-D。
// 目的：选项位置随机化交给脚本，不让大模型手动安排答案位置（省算力、防位置规律）。
//
// 用法：
//   node shuffle-quiz-options.mjs questions.json > shuffled.json
//   cat questions.json | node shuffle-quiz-options.mjs
//
// 输入格式（每道题恰好 1 个 is_correct: true）：
// [
//   {
//     "question_text": "...",
//     "options": [
//       { "label": "...", "description": "...", "is_correct": true },
//       { "label": "...", "description": "..." },
//       { "label": "...", "description": "..." },
//       { "label": "...", "description": "..." }
//     ]
//   }
// ]
//
// 输出：洗牌后同样结构，每个 option 带上 value（A-D），is_correct 保留。

import fs from "node:fs";

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fail(msg) {
  console.error(`[shuffle-quiz-options] ${msg}`);
  process.exit(1);
}

let raw;
try {
  raw = process.argv[2]
    ? fs.readFileSync(process.argv[2], "utf8")
    : fs.readFileSync(0, "utf8");
} catch (e) {
  fail(`读取失败: ${e.message}`);
}

let questions;
try {
  questions = JSON.parse(raw);
} catch (e) {
  fail(`JSON 解析失败: ${e.message}`);
}

if (!Array.isArray(questions) || questions.length === 0) {
  fail("输入必须是题目数组，且至少 1 题");
}

const values = ["A", "B", "C", "D"];
for (const q of questions) {
  if (!q.question_text || !Array.isArray(q.options) || q.options.length !== 4) {
    fail(`每题必须有 question_text 和恰好 4 个选项: ${q.question_text ?? "(空)"}`);
  }
  const correct = q.options.filter((o) => o.is_correct);
  if (correct.length !== 1) {
    fail(`每题必须恰好 1 个正确答案，当前 ${correct.length} 个: ${q.question_text}`);
  }
  shuffle(q.options);
  q.options.forEach((o, i) => {
    o.value = values[i];
  });
}

console.log(JSON.stringify(questions, null, 2));
