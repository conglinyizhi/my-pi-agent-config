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
	"time"
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
	// socketPath 只给 presence 查询用：那条路要自己另开短连接（见 presence.go）
	socketPath     string
	presenceWindow time.Duration
	presenceRetry  time.Duration
	// questions 是一次提问的现场（一题一张卡，集齐答案才提交）。
	// 与 cards 分开存：两者的生命周期不同，混在一起会让结算路径互相牵连
	questions map[string]*questionState
	// delay 攒着还没到点的决策卡。审批与提问共用一条队列：撤单条件一样
	// （都是 settled 广播），分开反而多一处要维护的状态
	delay *cardQueue
}

func main() {
	home, _ := os.UserHomeDir()
	socketPath := flag.String("socket", filepath.Join(home, ".pi", "agent", "run", "hub.sock"), "hub Unix socket")
	larkBin := flag.String("lark-cli", "lark-cli", "lark-cli 路径")
	// 决策卡（审批 / 提问）延迟多久再推。用户常就在屏幕前，本机闸门窗或本地 TUI
	// 已经把决策拿走了；压这两分钟能省掉一次打扰和一次飞书 API 调用。0 = 立刻推
	cardDelay := flag.Duration("card-delay", 2*time.Minute, "决策卡延迟多久再推给 IM；0 = 立刻")
	// 到点后还要问一句「用户还在电脑前吗」：在就先不推，等 presence-retry 再问。
	// 这一步只省打扰，不省事——查不到照样推。0 = 关掉这次询问
	presenceWindow := flag.Duration("presence-window", 5*time.Minute, "本机最近这么久内有键鼠活动就不推卡；0 = 不查在场状态")
	// 人在电脑前时的重试间隔。注意：用户一直坐着的话，这条 ask 会一直被延到
	// 过期（pushCards 会跳过过期卡），这是要的行为，不是漏推
	presenceRetry := flag.Duration("presence-retry", time.Minute, "因本机有人而延后时的重试间隔")
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
		hub:            hub,
		lark:           cli,
		chats:          map[string]string{},
		cards:          map[string]askTarget{},
		questions:      map[string]*questionState{},
		delay:          newCardQueue(*cardDelay),
		socketPath:     *socketPath,
		presenceWindow: *presenceWindow,
		presenceRetry:  *presenceRetry,
	}
	hub.onEvent = a.onAskEvent
	hub.onSettle = a.onSettled

	go a.consume("im.message.receive_v1", a.onMessage)
	go a.consume("card.action.trigger", a.onCard)

	log.Printf("feishu adapter ready cli=%s hub=%s card-delay=%s presence-window=%s presence-retry=%s",
		bin, *socketPath, *cardDelay, *presenceWindow, *presenceRetry)
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

// onAskEvent 收下决策请求，先压 card-delay 再推卡。
//
// 压这一段的理由：用户就在屏幕前时，本机闸门窗（审批）或本地 TUI（提问）已经把决策
// 拿走了，这张卡既多余又费一次飞书 API。到点前结算的话，settled 广播会来撤单；
// 撤不到（卡已经发了）也没关系，照常走改卡那条路。
//
// 到点时再加一道在场闸门（holdWhilePresent）：人还在机器前就再压一轮，问到他
// 起身或这条 ask 过期为止。
//
// 例外：发起方在 payload 里标了 urgent（本地没人能答，或这件事要人马上到场），
// 就不压这一段，直接推——那条路上没有「人在就先不推」的余地。
func (a *adapter) onAskEvent(env envelope) {
	if env.Event != "ask" || env.RequestID == "" {
		return
	}
	if payloadFlag(env.Payload, "urgent") {
		a.delay.pushNow(env.RequestID, func() { a.pushCards(env) })
		return
	}
	// -card-delay 0 是用户明说要「立刻推」，那条路上不再拿在场状态反过来压：
	// schedule 看到 delay <= 0 就直接 send，hold 不生效
	a.delay.pushGated(env.RequestID, a.holdWhilePresent(env.RequestID), a.presenceRetry, func() { a.pushCards(env) })
}

// pushCards 到点后真正推卡。目标名单以 hub 下发的授权名单为准，
// 不能只看 a.chats：那张表是适配器进程内的，一重启就空，卡会静默地送不出去。
func (a *adapter) pushCards(env envelope) {
	// 到点时已经过期就别发了：hub 的 expired 结算（5 秒一跳）可能还在路上，
	// 推出去就是一张按钮按不动的死卡
	if askExpired(env.ExpiresAt) {
		log.Printf("ask %s 已过期，不发卡", env.RequestID)
		return
	}
	targets := a.pushTargets(env.Principals)
	if len(targets) == 0 {
		log.Printf("ask %s：本通道没有已授权账号，审批卡没推出去", env.RequestID)
		return
	}
	cmd := commandOf(env.Payload)
	// 提问：一题一张卡，集齐答案才提交，走单独一条路
	if env.Kind == "question" {
		a.pushQuestionCards(env, targets)
		return
	}
	for _, t := range targets {
		card := approvalCard(env.RequestID, env.Kind, cmd, env.SessionID, env.ExpiresAt)
		mid, err := a.lark.sendCard(t.ChatID, t.UserID, card)
		if err != nil {
			log.Printf("push card %s: %v", t.UserID, err)
			continue
		}
		a.mu.Lock()
		a.cards[env.RequestID] = askTarget{ChatID: t.ChatID, UserID: t.UserID, MessageID: mid}
		a.mu.Unlock()
	}
}

// pushTargets 挑出这次要推卡的人：只认 hub 的授权名单，本通道之外的、重复的都不要。
// 跟 bot 说过话就用已知 chat，不知道就直接按 open_id 发——bot 直发 open_id 是通的，
// 所以不要求账号先主动开过会话。
func (a *adapter) pushTargets(principals []principal) []askTarget {
	a.mu.Lock()
	known := make(map[string]string, len(a.chats))
	for u, c := range a.chats {
		known[u] = c
	}
	a.mu.Unlock()

	targets := make([]askTarget, 0, len(principals))
	seen := make(map[string]bool, len(principals))
	for _, p := range principals {
		if p.Channel != channelName || p.UserID == "" || seen[p.UserID] {
			continue
		}
		seen[p.UserID] = true
		targets = append(targets, askTarget{ChatID: known[p.UserID], UserID: p.UserID})
	}
	return targets
}

func (a *adapter) onSettled(env envelope) {
	// 还没到点的卡先撤掉：用户已经答过了（本机窗、本地 TUI，或其他收件人先答），
	// 再推一张卡纯属多余。撤不到说明卡已经发出去了，下面照常改卡
	if a.delay.cancel(env.RequestID) {
		log.Printf("ask %s 在发卡前已结算，撤掉卡片", env.RequestID)
	}

	a.mu.Lock()
	t, ok := a.cards[env.RequestID]
	if ok {
		delete(a.cards, env.RequestID)
	}
	q, qok := a.questions[env.RequestID]
	if qok {
		delete(a.questions, env.RequestID)
	}
	a.mu.Unlock()

	if ok && t.MessageID != "" {
		if err := a.lark.patchCard(t.MessageID, settledCard(env.Action, env.Reason, env.By)); err != nil {
			log.Printf("patch settled: %v", err)
		}
	}
	if qok {
		a.patchQuestionSettled(q, env)
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
	a.rememberChat(userID, chatID)

	// 提问卡的提交带 form_value。先让提问那条路认领；认不出来（不是我们发的提问卡）
	// 再按审批卡的 action_value 处理。两条路的回调长得很像，靠这个顺序分开
	if formJSON := str(ev["form_value"]); formJSON != "" {
		if a.handleQuestionSubmit(userID, chatID, str(ev["message_id"]), str(ev["action_name"]), formJSON) {
			return
		}
	}

	action, requestID := parseCardValue(str(ev["action_value"]))
	if userID == "" || action == "" || requestID == "" {
		return
	}
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
	out, err := a.hub.decide(requestID, action, comment, userID, "", nil)
	if err != nil {
		log.Printf("decide: %v", err)
		return
	}
	if out.Type == "error" {
		a.handlePair(userID, chatID)
		return
	}
	if out.Type != "decide-ok" {
		// 意外回执：hub 的 pending 通道没按请求 id 匹配，并发 RPC 时可能串号。
		// 宁可写日志，也不要错报「已提交」。
		log.Printf("decide: 意外回执 %s（%s）", out.Type, out.Message)
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
