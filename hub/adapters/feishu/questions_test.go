package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func boolPtr(b bool) *bool { return &b }

func sampleQuestion() question {
	return question{
		ID:      "q1",
		Label:   "隔离方式",
		Text:    "这次改造会动共享脚本，怎么隔离工作区？",
		Options: []questionOption{{Value: "worktree", Label: "用 git worktree 隔离"}, {Value: "branch", Label: "直接开分支"}},
	}
}

// ── answerFrom：自由输入优先、对不上号也要留住选择 ──────────────────────

func TestAnswerFromPrefersCustom(t *testing.T) {
	q := sampleQuestion()
	got, ok := answerFrom(q, map[string]string{"sel_1": "worktree", "custom_1": "  先复制一份再改  "}, 1)
	if !ok {
		t.Fatal("应当算作答")
	}
	if !got.WasCustom || got.Value != "先复制一份再改" || got.Label != "先复制一份再改" {
		t.Fatalf("%+v", got)
	}
}

func TestAnswerFromOption(t *testing.T) {
	got, ok := answerFrom(sampleQuestion(), map[string]string{"sel_1": "branch"}, 1)
	if !ok || got.WasCustom || got.Value != "branch" || got.Label != "直接开分支" {
		t.Fatalf("%+v ok=%v", got, ok)
	}
}

func TestAnswerFromUnknownOptionKeepsValue(t *testing.T) {
	// 卡片被手改过 / 两侧版本不一致：值对不上号时按原值记，不能丢掉用户的选择
	got, ok := answerFrom(sampleQuestion(), map[string]string{"sel_1": "something-else"}, 1)
	if !ok || got.Value != "something-else" || got.Label != "something-else" {
		t.Fatalf("%+v ok=%v", got, ok)
	}
}

func TestAnswerFromEmptyIsNotAnAnswer(t *testing.T) {
	if _, ok := answerFrom(sampleQuestion(), map[string]string{}, 1); ok {
		t.Fatal("既没选也没写不该当成作答")
	}
	if _, ok := answerFrom(sampleQuestion(), map[string]string{"custom_1": "   "}, 1); ok {
		t.Fatal("只填空格也不算作答")
	}
}

func TestAnswerFromUsesOneBasedQuestionNumber(t *testing.T) {
	// 回归：曾经拿 0 起的 slice 下标记键名，查的是 custom_0 而卡片上的控件名是 custom_1，
	// 表现是「用户明明写了却说没选也没写」——两侧约定统一为 1 起
	q := sampleQuestion()
	if got, ok := answerFrom(q, map[string]string{"custom_1": "写了点什么"}, 1); !ok || !got.WasCustom {
		t.Fatalf("第 1 题的键名是 custom_1: %+v ok=%v", got, ok)
	}
	if _, ok := answerFrom(q, map[string]string{"custom_0": "写了点什么"}, 1); ok {
		t.Fatal("0 起的键名不该被认；认了就说明约定又漂回 0 起了")
	}
	if _, ok := answerFrom(q, map[string]string{"sel_1": "branch"}, 2); ok {
		t.Fatal("第 2 题不该去读第 1 题的键")
	}
	if got, ok := answerFrom(q, map[string]string{"sel_2": "branch"}, 2); !ok || got.Value != "branch" {
		t.Fatalf("%+v ok=%v", got, ok)
	}
}

// ── parseQuestions ─────────────────────────────────────────────────────

func TestParseQuestionsAllowOtherDefaultsTrue(t *testing.T) {
	payload := map[string]any{
		"questions": []any{
			map[string]any{
				"id":            "q1",
				"label":         "隔离方式",
				"question_text": "怎么隔离？",
				"options":       []any{map[string]any{"value": "worktree", "label": "worktree"}},
				// 故意不带 allowOther
			},
			map[string]any{
				"id":            "q2",
				"question_text": "验收范围？",
				"options":       []any{map[string]any{"value": "a", "label": "A"}},
				"allowOther":    false,
			},
		},
	}
	questions := parseQuestions(payload)
	if len(questions) != 2 {
		t.Fatalf("解析出 %d 题", len(questions))
	}
	if !questions[0].allowOther() {
		t.Fatal("缺 allowOther 时应按允许自由输入处理")
	}
	if questions[1].allowOther() {
		t.Fatal("显式 false 要生效")
	}
}

func TestParseQuestionsJunk(t *testing.T) {
	if got := parseQuestions(map[string]any{}); got != nil {
		t.Fatalf("%+v", got)
	}
	if got := parseQuestions(map[string]any{"questions": "不是数组"}); got != nil {
		t.Fatalf("%+v", got)
	}
}

// ── 卡面 ───────────────────────────────────────────────────────────────

func decodeCard(t *testing.T, raw string) map[string]any {
	t.Helper()
	var card map[string]any
	if err := json.Unmarshal([]byte(raw), &card); err != nil {
		t.Fatalf("卡不是合法 JSON: %v", err)
	}
	return card
}

func cardTitle(t *testing.T, card map[string]any) string {
	t.Helper()
	header, _ := card["header"].(map[string]any)
	title, _ := header["title"].(map[string]any)
	s, _ := title["content"].(string)
	return s
}

// 递归收 name：控件可能嵌在 column_set > column > button 里，只收一层会漏
func elementNames(card map[string]any) []string {
	var names []string
	var walk func(node any)
	walk = func(node any) {
		switch v := node.(type) {
		case map[string]any:
			if n, _ := v["name"].(string); n != "" {
				names = append(names, n)
			}
			for _, child := range v {
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(card)
	return names
}

func TestQuestionCardNamesMatchContract(t *testing.T) {
	card := decodeCard(t, questionCard(2, 3, sampleQuestion(), "ask-1", "12:30", ""))
	if got := cardTitle(t, card); got != "提问 [2/3]" {
		t.Fatalf("title %q", got)
	}
	names := elementNames(card)
	want := []string{"sel_2", "custom_2", "btn_deny", "btn_answer"}
	for _, w := range want {
		if !hasName(names, w) {
			t.Fatalf("缺控件 %s，实际 %v", w, names)
		}
	}
}

func TestQuestionCardDropsInputWhenAllowOtherFalse(t *testing.T) {
	q := sampleQuestion()
	q.AllowOther = boolPtr(false)
	card := decodeCard(t, questionCard(1, 1, q, "ask-1", "12:30", ""))
	if hasName(elementNames(card), "custom_1") {
		t.Fatal("不允许自由输入时不该出现输入框")
	}
	if !strings.Contains(mustJSON(card), "选一个，点「提交本题」回传") {
		t.Fatal("没有输入框就不该提示用户去写")
	}
}

func TestQuestionSettledCardStates(t *testing.T) {
	q := sampleQuestion()

	answered := mustJSON(decodeCard(t, questionSettledCard(1, 3, q, &hubAnswer{ID: "q1", Value: "worktree", Label: "用 git worktree 隔离"}, "allow")))
	if !strings.Contains(answered, "已答 [1/3]") || !strings.Contains(answered, "选择：用 git worktree 隔离") {
		t.Fatalf("答过的卡不对: %s", answered)
	}
	if strings.Contains(answered, "btn_answer") {
		t.Fatal("决断后不该还留着按钮")
	}

	custom := mustJSON(decodeCard(t, questionSettledCard(1, 3, q, &hubAnswer{Value: "先复制一份", Label: "先复制一份", WasCustom: true}, "allow")))
	if !strings.Contains(custom, "自己写：先复制一份") {
		t.Fatalf("自由输入该标成自己写: %s", custom)
	}

	cancelled := mustJSON(decodeCard(t, questionSettledCard(2, 3, q, nil, "deny")))
	if !strings.Contains(cancelled, "已取消 [2/3]") || !strings.Contains(cancelled, "未作答") {
		t.Fatalf("取消的卡不对: %s", cancelled)
	}
}

// ── 现场状态机 ─────────────────────────────────────────────────────────

func TestQuestionStateCollectsInOrder(t *testing.T) {
	state := newQuestionState("ask-1", "12:30", []question{sampleQuestion(), sampleQuestion()}, []askTarget{
		{MessageID: "om_1"},
		{MessageID: "om_2"},
	})
	if state.allAnswered() {
		t.Fatal("一题没答就不该算答完")
	}
	// 先答第 2 题：不算答完，也不能把它挤到第 1 位
	state.answers[1] = hubAnswer{ID: "q2", Value: "b"}
	if state.allAnswered() {
		t.Fatal("只答了一题")
	}
	got := state.collected()
	if len(got) != 1 || got[0].Value != "b" {
		t.Fatalf("%+v", got)
	}
	state.answers[0] = hubAnswer{ID: "q1", Value: "a"}
	if !state.allAnswered() {
		t.Fatal("两题都答完应算答完")
	}
	got = state.collected()
	if len(got) != 2 || got[0].Value != "a" || got[1].Value != "b" {
		t.Fatalf("应按题号顺序: %+v", got)
	}
}

func TestQuestionStateMapsMessageToIndex(t *testing.T) {
	state := newQuestionState("ask-1", "12:30", []question{sampleQuestion(), sampleQuestion()}, []askTarget{
		{MessageID: "om_a"},
		{MessageID: ""}, // 发送失败的那题没有 message_id
	})
	if i, ok := state.byMessage["om_a"]; !ok || i != 0 {
		t.Fatalf("om_a -> %d ok=%v", i, ok)
	}
	if _, ok := state.byMessage[""]; ok {
		t.Fatal("空 message_id 不该进映射，否则任何没有 id 的回调都会被认成这题")
	}
}

func TestOptionDescriptionsPerLineAndMerged(t *testing.T) {
	q := sampleQuestion()
	q.Options[0].Description = "互不干扰，但依赖要重装一遍"
	q.Options[1].Description = ""
	q.Options = append(q.Options, questionOption{Value: "later", Label: "以后再说", Description: "先记一笔"})

	desc := optionDescriptions(q.Options)
	lines := strings.Split(desc, "\n")
	if len(lines) != 2 {
		t.Fatalf("只该有带说明的两条: %q", desc)
	}
	for _, line := range lines {
		// 一个 <font> 跨多行时闭合会丢，最后一行会把 </font> 当字面量显示出来（实测过）
		if !strings.HasPrefix(line, "<font color='grey'>") || !strings.HasSuffix(line, "</font>") {
			t.Fatalf("每行都得自己闭合: %q", line)
		}
	}
	if strings.Contains(desc, "直接开分支：") {
		t.Fatalf("空说明不该出现: %q", desc)
	}
}

func TestOptionDescriptionsEmptyWhenNone(t *testing.T) {
	if got := optionDescriptions(sampleQuestion().Options); got != "" {
		t.Fatalf("都没说明时不该生成块: %q", got)
	}
}

func TestEmptySubmitWarningShownOnCard(t *testing.T) {
	// 飞书卡片回调由 SDK 自动应答，没有 toast 通道：只能改卡告诉用户「你没选」
	warned := mustJSON(decodeCard(t, questionCard(1, 1, sampleQuestion(), "ask-1", "12:30", emptySubmitWarning)))
	if !strings.Contains(warned, emptySubmitWarning) {
		t.Fatalf("提醒没进卡面: %s", warned)
	}
	if !strings.Contains(warned, "sel_1") {
		t.Fatal("重画的卡还得留着控件，否则用户没法补选")
	}
	plain := mustJSON(decodeCard(t, questionCard(1, 1, sampleQuestion(), "ask-1", "12:30", "")))
	if strings.Contains(plain, emptySubmitWarning) {
		t.Fatal("没出问题时不该带提醒")
	}
}

func TestFormKeysSortedForLog(t *testing.T) {
	got := formKeys(map[string]string{"sel_2": "x", "custom_2": "y"})
	if len(got) != 2 || got[0] != "custom_2" || got[1] != "sel_2" {
		t.Fatalf("%v", got)
	}
}

func hasName(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func mustJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
