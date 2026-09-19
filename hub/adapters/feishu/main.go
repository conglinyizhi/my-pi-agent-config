package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
)

type askTarget struct {
	ChatID    string
	UserID    string
	MessageID string
}

type adapter struct {
	hub   *hubClient
	lark  *larkCLI
	mu    sync.Mutex
	chats map[string]string // userID -> chatID
	cards map[string]askTarget
}

func main() {
	home, _ := os.UserHomeDir()
	socketPath := flag.String("socket", filepath.Join(home, ".pi", "agent", "run", "hub.sock"), "hub Unix socket")
	larkBin := flag.String("lark-cli", "lark-cli", "lark-cli 路径")
	flag.Parse()

	bin, err := exec.LookPath(*larkBin)
	if err != nil {
		log.Print(larkMissingHint(*larkBin))
		os.Exit(78) // EX_CONFIG：缺依赖，systemd Restart=on-failure 不会重试
	}
	cli := newLarkCLI(bin, "bot")
	if err := cli.authOK(); err != nil {
		log.Print(larkLoginHint(err))
		os.Exit(78)
	}

	hub, err := dialHub(*socketPath)
	if err != nil {
		log.Fatalf("连不上 hub（%s）：%v", *socketPath, err)
	}
	defer hub.close()

	a := &adapter{
		hub:   hub,
		lark:  cli,
		chats: map[string]string{},
		cards: map[string]askTarget{},
	}
	hub.onEvent = a.onAskEvent
	hub.onSettle = a.onSettled

	go a.consume("im.message.receive_v1", a.onMessage)
	go a.consume("card.action.trigger", a.onCard)

	log.Printf("feishu adapter ready cli=%s hub=%s", bin, *socketPath)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}

func (a *adapter) rememberChat(userID, chatID string) {
	if userID == "" || chatID == "" {
		return
	}
	a.mu.Lock()
	a.chats[userID] = chatID
	a.mu.Unlock()
}

func (a *adapter) consume(key string, handle func(map[string]any)) {
	cmd, stdout, err := a.lark.consume(key)
	if err != nil {
		log.Printf("consume %s: %v", key, err)
		return
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(line, &obj) != nil {
			continue
		}
		handle(obj)
	}
	_ = cmd.Wait()
	log.Printf("consume %s 退出", key)
}

func (a *adapter) onAskEvent(env envelope) {
	if env.Event != "ask" || env.RequestID == "" {
		return
	}
	cmd := commandOf(env.Payload)
	a.mu.Lock()
	chats := make(map[string]string, len(a.chats))
	for u, c := range a.chats {
		chats[u] = c
	}
	a.mu.Unlock()
	for userID, chatID := range chats {
		card := approvalCard(env.RequestID, env.Kind, cmd, env.SessionID, env.ExpiresAt)
		mid, err := a.lark.sendCard(chatID, userID, card)
		if err != nil {
			log.Printf("push card %s: %v", userID, err)
			continue
		}
		a.mu.Lock()
		a.cards[env.RequestID] = askTarget{ChatID: chatID, UserID: userID, MessageID: mid}
		a.mu.Unlock()
	}
}

func (a *adapter) onSettled(env envelope) {
	a.mu.Lock()
	t, ok := a.cards[env.RequestID]
	if ok {
		delete(a.cards, env.RequestID)
	}
	a.mu.Unlock()
	if !ok || t.MessageID == "" {
		return
	}
	if err := a.lark.editMarkdown(t.MessageID, settledMarkdown(env.Action, env.Reason, env.By)); err != nil {
		log.Printf("edit settled: %v", err)
	}
}

func (a *adapter) onMessage(ev map[string]any) {
	userID := str(ev["sender_id"])
	chatID := str(ev["chat_id"])
	content := str(ev["content"])
	if userID == "" {
		return
	}
	a.rememberChat(userID, chatID)
	cmd := parseTextCommand(content)
	switch cmd.Kind {
	case "list":
		a.handleList(userID, chatID)
	case "allow", "deny":
		a.handleDecide(userID, chatID, cmd.Kind, cmd.RequestID, cmd.Comment)
	default:
		a.handlePair(userID, chatID)
	}
}

func (a *adapter) onCard(ev map[string]any) {
	userID := str(ev["operator_id"])
	chatID := str(ev["chat_id"])
	action, requestID := parseCardValue(str(ev["action_value"]))
	if userID == "" || action == "" || requestID == "" {
		return
	}
	a.rememberChat(userID, chatID)
	a.handleDecide(userID, chatID, action, requestID, "")
}

func (a *adapter) handlePair(userID, chatID string) {
	out, err := a.hub.pair(userID, "")
	if err != nil {
		log.Printf("pair: %v", err)
		return
	}
	if out.Type == "pair-ok" {
		_ = a.lark.sendText(chatID, userID, "已授权。发 /list 看未决审批。")
		return
	}
	if out.Type == "unauthorized" && out.Code != "" {
		_ = a.lark.sendText(chatID, userID, pairingText(out.Code, out.Message, out.ExpiresAt))
		return
	}
	if out.Message != "" {
		_ = a.lark.sendText(chatID, userID, out.Message)
	}
}

func (a *adapter) handleList(userID, chatID string) {
	out, err := a.hub.list(userID, "")
	if err != nil {
		log.Printf("list: %v", err)
		return
	}
	if out.Type == "error" {
		a.handlePair(userID, chatID)
		return
	}
	if len(out.Items) == 0 {
		_ = a.lark.sendText(chatID, userID, "没有未决审批")
		return
	}
	for _, item := range out.Items {
		card := approvalCard(item.RequestID, item.Kind, item.Command, item.SessionID, item.ExpiresAt)
		mid, err := a.lark.sendCard(chatID, userID, card)
		if err != nil {
			log.Printf("send card: %v", err)
			_ = a.lark.sendText(chatID, userID, listText(out.Items))
			return
		}
		a.mu.Lock()
		a.cards[item.RequestID] = askTarget{ChatID: chatID, UserID: userID, MessageID: mid}
		a.mu.Unlock()
	}
}

func (a *adapter) handleDecide(userID, chatID, action, requestID, comment string) {
	if requestID == "" {
		_ = a.lark.sendText(chatID, userID, "用法：/allow <requestId> [附言]")
		return
	}
	out, err := a.hub.decide(requestID, action, comment, userID, "")
	if err != nil {
		log.Printf("decide: %v", err)
		return
	}
	if out.Type == "error" {
		a.handlePair(userID, chatID)
		return
	}
	_ = a.lark.sendText(chatID, userID, fmt.Sprintf("已提交 %s %s", action, requestID))
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func larkMissingHint(bin string) string {
	return fmt.Sprintf("未找到 lark-cli（%s）。飞书通道不启。安装：pnpm add -g @larksuite/cli && lark-cli config init && lark-cli auth login。说明见 hub/adapters/feishu/README.md。", bin)
}

func larkLoginHint(err error) string {
	return fmt.Sprintf("lark-cli 未登录：%v。先 lark-cli auth login，再 systemctl --user start pi-hub-feishu.service。", err)
}
