package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

type cardValue struct {
	Action    string `json:"action"`
	RequestID string `json:"requestId"`
}

func approvalCard(requestID, kind, command, sessionID, expiresAt string) string {
	if command == "" {
		command = "(无命令)"
	}
	if len(command) > 800 {
		command = command[:800] + "…"
	}
	meta := strings.TrimSpace(strings.Join([]string{
		nonEmpty("会话 ", sessionID),
		nonEmpty("至 ", expiresAt),
		nonEmpty("id ", requestID),
	}, " · "))
	title := "审批"
	if kind != "" {
		title = "审批 · " + kind
	}
	card := map[string]any{
		"schema": "2.0",
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": title},
			"template": "orange",
		},
		"body": map[string]any{
			"elements": []any{
				map[string]any{"tag": "markdown", "content": "**命令**\n```\n" + command + "\n```"},
				map[string]any{"tag": "markdown", "content": meta},
				map[string]any{
					"tag": "column_set",
					"columns": []any{
						buttonColumn("允许", "primary_filled", "allow", requestID),
						buttonColumn("拒绝", "danger", "deny", requestID),
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(card)
	return string(raw)
}

func buttonColumn(label, typ, action, requestID string) map[string]any {
	return map[string]any{
		"tag":    "column",
		"width":  "weighted",
		"weight": 1,
		"elements": []any{
			map[string]any{
				"tag":   "button",
				"text":  map[string]any{"tag": "plain_text", "content": label},
				"type":  typ,
				"width": "fill",
				"behaviors": []any{
					map[string]any{
						"type":  "callback",
						"value": map[string]string{"action": action, "requestId": requestID},
					},
				},
			},
		},
	}
}

func settledMarkdown(action, reason, by string) string {
	line := "已决断：**" + action + "**"
	if reason != "" || by != "" {
		line += "\n" + strings.TrimSpace(reason+" / "+by)
	}
	return line
}

// settledCard 是决断后拿去替换原卡的卡：按钮换掉，免得过期按钮还能点。
// 用同一种 schema 2.0 结构，因为改卡走的是 messages patch。
func settledCard(action, reason, by string) string {
	template := "green"
	if action == "deny" {
		template = "red"
	}
	card := map[string]any{
		"schema": "2.0",
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": settledTitle(action)},
			"template": template,
		},
		"body": map[string]any{
			"elements": []any{
				map[string]any{"tag": "markdown", "content": settledMarkdown(action, reason, by)},
			},
		},
	}
	raw, _ := json.Marshal(card)
	return string(raw)
}

func settledTitle(action string) string {
	switch action {
	case "allow":
		return "已决断 · 允许"
	case "deny":
		return "已决断 · 拒绝"
	default:
		return "已决断 · " + action
	}
}

func pairingText(code, message, expiresAt string) string {
	if message == "" {
		message = "当前账号未授权，请等待核心授权。若你就是机主，把下面这段复制给核心。"
	}
	var b strings.Builder
	b.WriteString(message)
	b.WriteString("\n\n`")
	b.WriteString(code)
	b.WriteString("`")
	if expiresAt != "" {
		b.WriteString("\n有效至 ")
		b.WriteString(expiresAt)
	}
	b.WriteString("\n\n本机授权：`/remote:allow-key ")
	b.WriteString(code)
	b.WriteString("`")
	return b.String()
}

func listText(items []listItem) string {
	if len(items) == 0 {
		return "没有未决审批"
	}
	var b strings.Builder
	b.WriteString("未决审批\n")
	for _, it := range items {
		cmd := it.Command
		if cmd == "" {
			cmd = it.RequestID
		}
		fmt.Fprintf(&b, "\n`%s`  %s\n%s  至 %s\n/allow %s\n", it.RequestID, it.Kind, cmd, it.ExpiresAt, it.RequestID)
	}
	return b.String()
}

func parseCardValue(raw string) (action, requestID string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	var v cardValue
	if json.Unmarshal([]byte(raw), &v) != nil {
		return "", ""
	}
	if v.Action != "allow" && v.Action != "deny" {
		return "", ""
	}
	return v.Action, v.RequestID
}

type textCmd struct {
	Kind      string // list, allow, deny, other
	RequestID string
	Comment   string
}

func parseTextCommand(content string) textCmd {
	s := strings.TrimSpace(content)
	s = strings.TrimPrefix(s, "/")
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return textCmd{Kind: "other"}
	}
	switch strings.ToLower(fields[0]) {
	case "list":
		return textCmd{Kind: "list"}
	case "allow", "deny":
		cmd := textCmd{Kind: strings.ToLower(fields[0])}
		if len(fields) > 1 {
			cmd.RequestID = fields[1]
		}
		if len(fields) > 2 {
			cmd.Comment = strings.Join(fields[2:], " ")
		}
		return cmd
	default:
		return textCmd{Kind: "other"}
	}
}

func nonEmpty(prefix, v string) string {
	if v == "" {
		return ""
	}
	return prefix + v
}
