package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
)

// 提问卡：把 pi 的 ask_question 扇出成 N 张卡（一题一张），答完一题算一题。
//
// 与审批卡的关键差别：审批是 allow/deny 一个动作，一次回调就结算；提问要等用户把每一题
// 都答完，集齐后才带着 answers 一次性提交。所以这里必须留住中间态，而且**不能**在收到
// 第一次表单提交时就去 decide —— 那会把只答了一半的结果当成完整答复。
//
// 认题靠回调里的 message_id（lark-cli 的卡片回调会带），不在名字里编码题号：
// 下拉没被碰过时 form_value 里可能根本没有 sel_i 这个键，靠键名推题号会漏。

const (
	answerButtonName = "btn_answer"
	denyButtonName   = "btn_deny"
	// emptySubmitWarning 是「什么都没选就点提交」后重画到卡上的提醒。
	// 飞书的卡片回调由 SDK 自动应答，没有 toast 通道，只能改卡告诉用户
	emptySubmitWarning = "先选一个，或在下面写点什么，再点提交"
)

type questionOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type question struct {
	ID         string           `json:"id"`
	Label      string           `json:"label"`
	Text       string           `json:"question_text"`
	Options    []questionOption `json:"options"`
	AllowOther *bool            `json:"allowOther"`
}

// 缺字段按允许自由输入处理：pi 侧会显式带上，但缺省值取 true 才符合 ask_question 的语义
func (q question) allowOther() bool { return q.AllowOther == nil || *q.AllowOther }

// hubAnswer 与 hub/proto.go 的 Answer 字段对齐。hub 不解释它，只原样透传给 pi
type hubAnswer struct {
	ID        string `json:"id"`
	Value     string `json:"value"`
	Label     string `json:"label"`
	WasCustom bool   `json:"wasCustom,omitempty"`
}

// questionState 是一次提问的现场：卡位、题号映射、已收到的答案
//
// settled 标记与现场的生命周期有关：结算后不能立即删——hub 的 settled 广播还会回来，
// 剩下那几题要改卡得靠现场里的卡位。所以标记为已结算，等 settled 到了再清。
type questionState struct {
	requestID string
	questions []question
	expiresAt string
	cards     []askTarget    // 下标 = 题号-1；同一题多收件人时记第一个
	byMessage map[string]int // 卡片 message_id -> 题号下标
	answers   map[int]hubAnswer
	settled   bool
}

func newQuestionState(requestID, expiresAt string, questions []question, cards []askTarget) *questionState {
	byMessage := make(map[string]int, len(cards))
	for i, c := range cards {
		if c.MessageID != "" {
			byMessage[c.MessageID] = i
		}
	}
	return &questionState{
		requestID: requestID,
		questions: questions,
		expiresAt: expiresAt,
		cards:     cards,
		byMessage: byMessage,
		answers:   map[int]hubAnswer{},
	}
}

func (s *questionState) allAnswered() bool { return len(s.answers) == len(s.questions) }

// collected 按题号顺序取已收答案。顺序必须跟着题目走：hub 与 pi 都按 id 认，
// 但顺序错乱会让日志和卡片看起来对不上
func (s *questionState) collected() []hubAnswer {
	out := make([]hubAnswer, 0, len(s.answers))
	for i := range s.questions {
		if a, ok := s.answers[i]; ok {
			out = append(out, a)
		}
	}
	return out
}

// answerFrom 从一次表单提交里取出答案。
//
// questionNo 从 1 开始，与卡片上的控件名（sel_<i> / custom_<i>）一致。
// 这里曾经收过 0 起的 slice 下标去拼键名，结果永远拼成 sel_0 而卡片上是 sel_1，
// 表现是「用户明明写了却说没选也没写」——两侧的约定改为都从 1 起。
func answerFrom(q question, values map[string]string, questionNo int) (hubAnswer, bool) {
	if custom := strings.TrimSpace(values[fmt.Sprintf("custom_%d", questionNo)]); custom != "" {
		return hubAnswer{ID: q.ID, Value: custom, Label: custom, WasCustom: true}, true
	}
	sel := values[fmt.Sprintf("sel_%d", questionNo)]
	if sel == "" {
		return hubAnswer{}, false
	}
	for _, o := range q.Options {
		if o.Value == sel {
			return hubAnswer{ID: q.ID, Value: sel, Label: o.Label}, true
		}
	}
	// 选项值对不上（卡片被手改过、或两侧版本不一致）时按原值记下来：
	// 丢掉用户的选择比记一个对不上号的值更糟
	return hubAnswer{ID: q.ID, Value: sel, Label: sel}, true
}

// formKeys 排序后的表单键，只用于日志：键名两侧对不上时（契约漂了）
// 光看「没选也没写」是分不出来的
func formKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// optionDescriptions 把选项自带的说明合成一个富文本块。
// 不下沉到下拉选项里（选项文本会被截），放卡面上用户才能先读后选。
//
// 每行各自包 <font>：一个标签跨多行时闭合会丢，最后一行会把 </font> 当字面量显示出来
func optionDescriptions(options []questionOption) string {
	lines := make([]string, 0, len(options))
	for _, o := range options {
		if strings.TrimSpace(o.Description) == "" {
			continue
		}
		lines = append(lines, "<font color='grey'>- "+o.Label+"："+o.Description+"</font>")
	}
	return strings.Join(lines, "\n")
}

// ── 卡面 ────────────────────────────────────────────────────────────────

const questionTemplate = "turquoise"

func questionSubtitle(q question, total int) string {
	if strings.TrimSpace(q.Label) != "" {
		return q.Label
	}
	return fmt.Sprintf("共 %d 个问题", total)
}

func selectElement(index int, q question) map[string]any {
	options := make([]any, 0, len(q.Options))
	for _, o := range q.Options {
		options = append(options, map[string]any{
			"text":  map[string]any{"tag": "plain_text", "content": o.Label},
			"value": o.Value,
		})
	}
	return map[string]any{
		"tag":         "select_static",
		"placeholder": map[string]any{"tag": "plain_text", "content": "选择"},
		"options":     options,
		"type":        "default",
		"width":       "fill",
		"required":    false,
		"name":        fmt.Sprintf("sel_%d", index),
	}
}

func inputElement(index int) map[string]any {
	return map[string]any{
		"tag":           "input",
		"name":          fmt.Sprintf("custom_%d", index),
		"placeholder":   map[string]any{"tag": "plain_text", "content": "或者自己写…"},
		"default_value": "",
		"width":         "fill",
		"max_length":    200,
		"required":      false,
	}
}

func questionButtons(denyLabel string) map[string]any {
	return map[string]any{
		"tag":                "column_set",
		"flex_mode":          "none",
		"horizontal_spacing": "8px",
		"columns": []any{
			buttonColumnOf(denyLabel, denyButtonName, "danger"),
			buttonColumnOf("✅ 提交本题", answerButtonName, "primary_filled"),
		},
	}
}

func buttonColumnOf(label, name, kind string) map[string]any {
	return map[string]any{
		"tag":            "column",
		"width":          "weighted",
		"weight":         1,
		"vertical_align": "center",
		"elements": []any{
			map[string]any{
				"tag":              "button",
				"text":             map[string]any{"tag": "plain_text", "content": label},
				"type":             kind,
				"width":            "fill",
				"form_action_type": "submit",
				"name":             name,
			},
		},
	}
}

func questionCardConfig() map[string]any {
	return map[string]any{
		"update_multi": true,
		"style": map[string]any{
			"text_size": map[string]any{
				"normal_v2": map[string]any{"default": "normal", "pc": "normal", "mobile": "heading"},
			},
		},
	}
}

// questionCard 一题一张：题面 +（有则显）选项说明 + 下拉 +（可选）自由输入 + 取消/提交本题。
// 形态与 card-design/question-<i>of<N>.json 一致，改版式要两边一起改。
// warn 非空时多一行橙色提醒（用在「什么都没选就点提交」之后）。
func questionCard(index, total int, q question, requestID, expiresAt, warn string) string {
	hint := "选一个，或在下面自己写；自己写的优先"
	if !q.allowOther() {
		hint = "选一个，点「提交本题」回传"
	}
	elements := []any{
		map[string]any{"tag": "markdown", "content": q.Text, "text_size": "normal"},
		map[string]any{"tag": "markdown", "content": "<font color='grey'>" + hint + "</font>", "text_size": "notation"},
	}
	if desc := optionDescriptions(q.Options); desc != "" {
		elements = append(elements, map[string]any{"tag": "markdown", "content": desc, "text_size": "notation"})
	}
	if warn != "" {
		elements = append(elements, map[string]any{
			"tag": "markdown", "content": "<font color='orange'>" + warn + "</font>", "text_size": "notation",
		})
	}
	elements = append(elements, selectElement(index, q))
	if q.allowOther() {
		elements = append(elements, inputElement(index))
	}
	elements = append(elements, questionButtons("🚫 取消"))

	card := map[string]any{
		"schema": "2.0",
		"config": questionCardConfig(),
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": fmt.Sprintf("提问 [%d/%d]", index, total)},
			"subtitle": map[string]any{"tag": "plain_text", "content": questionSubtitle(q, total)},
			"template": questionTemplate,
			"padding":  "12px 8px 12px 8px",
		},
		"body": map[string]any{
			"direction":        "vertical",
			"vertical_spacing": "4px",
			"elements": []any{
				map[string]any{"tag": "form", "name": fmt.Sprintf("q_form_%d", index), "elements": elements},
				map[string]any{
					"tag":       "markdown",
					"content":   fmt.Sprintf("<font color='grey'>%s · 至 %s</font>", requestID, expiresAt),
					"text_size": "notation",
					"margin":    "6px 0px 0px 0px",
				},
			},
		},
	}
	raw, _ := json.Marshal(card)
	return string(raw)
}

// questionSettledCard 决断后的形态：按钮全撤，只留题面与答案。
// 答过的绿、没答的灰，别让「没答」看起来像「答了」
func questionSettledCard(index, total int, q question, answer *hubAnswer, action string) string {
	title := fmt.Sprintf("已答 [%d/%d]", index, total)
	template := "green"
	body := []any{
		map[string]any{"tag": "markdown", "content": q.Text, "text_size": "normal"},
	}
	if action != "allow" {
		title = fmt.Sprintf("已取消 [%d/%d]", index, total)
		template = "grey"
	}
	switch {
	case action != "allow":
		body = append(body, map[string]any{
			"tag": "markdown", "content": "<font color='grey'>未作答</font>", "text_size": "notation",
		})
	case answer != nil && answer.WasCustom:
		body = append(body, map[string]any{
			"tag": "markdown", "content": "✍️ 自己写：" + answer.Label, "text_size": "normal",
		})
	case answer != nil:
		body = append(body, map[string]any{
			"tag": "markdown", "content": "✅ 选择：" + answer.Label, "text_size": "normal",
		})
	default:
		body = append(body, map[string]any{
			"tag": "markdown", "content": "<font color='grey'>未作答</font>", "text_size": "notation",
		})
	}

	card := map[string]any{
		"schema": "2.0",
		"config": questionCardConfig(),
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": title},
			"subtitle": map[string]any{"tag": "plain_text", "content": questionSubtitle(q, total)},
			"template": template,
			"padding":  "12px 8px 12px 8px",
		},
		"body": map[string]any{"direction": "vertical", "vertical_spacing": "4px", "elements": body},
	}
	raw, _ := json.Marshal(card)
	return string(raw)
}

// ── 扇出与回收 ──────────────────────────────────────────────────────────

// pushQuestionCards 给每个授权用户各发 N 张卡（一题一张），并把 card 位记进现场
func (a *adapter) pushQuestionCards(env envelope, targets []askTarget) {
	questions := parseQuestions(env.Payload)
	if len(questions) == 0 {
		log.Printf("ask %s：kind=question 但 payload 里没有题目，回退成审批卡", env.RequestID)
		return
	}

	cards := make([]askTarget, len(questions))
	for _, t := range targets {
		for i, q := range questions {
			card := questionCard(i+1, len(questions), q, env.RequestID, env.ExpiresAt, "")
			mid, err := a.lark.sendCard(t.ChatID, t.UserID, card)
			if err != nil {
				log.Printf("push question card %s 第 %d 题: %v", t.UserID, i+1, err)
				continue
			}
			if cards[i].MessageID == "" {
				cards[i] = askTarget{ChatID: t.ChatID, UserID: t.UserID, MessageID: mid}
			}
		}
	}

	state := newQuestionState(env.RequestID, env.ExpiresAt, questions, cards)
	a.mu.Lock()
	a.questions[env.RequestID] = state
	a.mu.Unlock()
	log.Printf("提问 %s：%d 题，已发 %d 张卡", env.RequestID, len(questions), len(state.byMessage))
}

// handleQuestionSubmit 认领一次卡片表单提交。返回 true 表示这确实是我们发出的提问卡
// （哪怕内容不合法也由这里处理完，不再往下走审批那条路）
func (a *adapter) handleQuestionSubmit(userID, chatID, messageID, buttonName, formJSON string) bool {
	a.mu.Lock()
	var state *questionState
	var index int
	for _, st := range a.questions {
		if i, ok := st.byMessage[messageID]; ok {
			state, index = st, i
			break
		}
	}
	if state != nil && state.settled {
		// 已经结算了（比如点了提交紧接着点取消）：吞掉，不再改状态
		a.mu.Unlock()
		return true
	}
	a.mu.Unlock()
	if state == nil {
		return false
	}

	// 取消：整场提问作废。停在第一题上也要能撤，所以每张卡都有这个按钮
	if buttonName == denyButtonName {
		a.finishQuestion(state, userID, "deny", nil)
		return true
	}
	if buttonName != answerButtonName {
		return true
	}

	var values map[string]string
	if err := json.Unmarshal([]byte(formJSON), &values); err != nil {
		log.Printf("提问 %s 第 %d 题：form_value 不是合法 JSON: %v", state.requestID, index+1, err)
		return true
	}
	answer, ok := answerFrom(state.questions[index], values, index+1)
	if !ok {
		// 既没选也没写：点一下提交按钮不等于作答。
		// 把按钮名与表单键一起打出来 —— 契约漂了（键名对不上）时，只有这里看得出来；
		// 同时把带提醒的卡重画上去，否则用户只看到「点了没反应」
		log.Printf("提问 %s 第 %d 题：没选也没写（按钮=%s 表单键=%v）", state.requestID, index+1, buttonName, formKeys(values))
		if c := state.cards[index]; c.MessageID != "" {
			card := questionCard(index+1, len(state.questions), state.questions[index], state.requestID, state.expiresAt, emptySubmitWarning)
			if err := a.lark.patchCard(c.MessageID, card); err != nil {
				log.Printf("patch empty-submit hint %s: %v", c.MessageID, err)
			}
		}
		return true
	}

	a.mu.Lock()
	state.answers[index] = answer
	done := state.allAnswered()
	collected := state.collected()
	a.mu.Unlock()

	// 本题单独改成已答：不这样，用户答完第二题就忘了第一题选了啥
	if c := state.cards[index]; c.MessageID != "" {
		if err := a.lark.patchCard(c.MessageID, questionSettledCard(index+1, len(state.questions), state.questions[index], &answer, "allow")); err != nil {
			log.Printf("patch answered card %s: %v", c.MessageID, err)
		}
	}

	if done {
		log.Printf("提问 %s：%d 题已答完，提交 hub", state.requestID, len(state.questions))
		a.finishQuestion(state, userID, "allow", collected)
	}
	return true
}

// finishQuestion 把提问结算给 hub。
//
// 不在此时清现场：结算后 hub 会广播 settled，剩下几题要改卡还得靠现场里的卡位。
// 只标 settled，真正删除交给 onSettled
func (a *adapter) finishQuestion(state *questionState, userID, action string, answers []hubAnswer) {
	a.mu.Lock()
	if state.settled {
		a.mu.Unlock()
		return
	}
	state.settled = true
	a.mu.Unlock()

	out, err := a.hub.decide(state.requestID, action, "", userID, "", answers)
	if err != nil {
		log.Printf("decide question %s: %v", state.requestID, err)
		return
	}
	if out.Type == "error" {
		log.Printf("decide question %s 被拒: %s", state.requestID, out.Message)
	}
}

// patchQuestionSettled 结算后把所有题卡改成终态，并清掉现场。
// 没答到的题标「未作答」：取消/超时的卡不该看起来像答过
func (a *adapter) patchQuestionSettled(state *questionState, env envelope) {
	a.mu.Lock()
	answers := make(map[int]hubAnswer, len(state.answers))
	for i, ans := range state.answers {
		answers[i] = ans
	}
	a.mu.Unlock()

	for i, c := range state.cards {
		if c.MessageID == "" {
			continue
		}
		var answer *hubAnswer
		if ans, ok := answers[i]; ok {
			answer = &ans
		}
		card := questionSettledCard(i+1, len(state.questions), state.questions[i], answer, env.Action)
		if err := a.lark.patchCard(c.MessageID, card); err != nil {
			log.Printf("patch question settled %s: %v", c.MessageID, err)
		}
	}
}

func parseQuestions(payload map[string]any) []question {
	raw, ok := payload["questions"]
	if !ok {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var questions []question
	if json.Unmarshal(data, &questions) != nil {
		return nil
	}
	return questions
}
