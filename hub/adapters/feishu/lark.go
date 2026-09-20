package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type larkCLI struct {
	bin string
	as  string
}

func newLarkCLI(bin, as string) *larkCLI {
	if as == "" {
		as = "bot"
	}
	return &larkCLI{bin: bin, as: as}
}

func (c *larkCLI) run(args ...string) ([]byte, error) {
	cmd := exec.Command(c.bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), fmt.Errorf("lark-cli %s: %s", strings.Join(args, " "), msg)
	}
	return stdout.Bytes(), nil
}

func (c *larkCLI) authOK() error {
	out, err := c.run("auth", "status", "--json")
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(out)) == 0 {
		return fmt.Errorf("lark-cli auth status 空输出")
	}
	return nil
}

func (c *larkCLI) sendText(chatID, userID, text string) error {
	args := []string{"im", "+messages-send", "--as", c.as, "--text", text, "--json"}
	if chatID != "" {
		args = append(args, "--chat-id", chatID)
	} else if userID != "" {
		args = append(args, "--user-id", userID)
	} else {
		return fmt.Errorf("没有 chat_id / user_id")
	}
	_, err := c.run(args...)
	return err
}

func (c *larkCLI) sendCard(chatID, userID, cardJSON string) (messageID string, err error) {
	args := []string{"im", "+messages-send", "--as", c.as, "--msg-type", "interactive", "--content", cardJSON, "--json"}
	if chatID != "" {
		args = append(args, "--chat-id", chatID)
	} else if userID != "" {
		args = append(args, "--user-id", userID)
	} else {
		return "", fmt.Errorf("没有 chat_id / user_id")
	}
	out, err := c.run(args...)
	if err != nil {
		return "", err
	}
	return extractMessageID(out), nil
}

// patchCard 更新已发出的互动卡片。改卡不能用 +messages-edit：那个只吃文本/富文本，
// 对 interactive 消息会报 230054（This operation is not supported for this message type），
// 卡改不动。要用 messages patch，且 content 得是 JSON 序列化后的字符串。
func (c *larkCLI) patchCard(messageID, cardJSON string) error {
	if messageID == "" {
		return fmt.Errorf("没有 message_id")
	}
	body, err := json.Marshal(map[string]string{"content": cardJSON})
	if err != nil {
		return err
	}
	_, err = c.run("im", "messages", "patch", "--as", c.as, "--message-id", messageID, "--data", string(body), "--json")
	return err
}

func extractMessageID(raw []byte) string {
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	for _, key := range []string{"message_id", "messageId"} {
		if s, ok := obj[key].(string); ok && s != "" {
			return s
		}
	}
	if data, ok := obj["data"].(map[string]any); ok {
		if s, ok := data["message_id"].(string); ok {
			return s
		}
	}
	return ""
}

func (c *larkCLI) consume(eventKey string) (*exec.Cmd, io.ReadCloser, error) {
	cmd := exec.Command(c.bin, "event", "consume", eventKey, "--as", c.as)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stderr = os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stdin = r
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		return nil, nil, err
	}
	go keepStdinOpen(w)
	return cmd, stdout, nil
}

func keepStdinOpen(w *os.File) {
	defer w.Close()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if _, err := w.Write([]byte{'\n'}); err != nil {
			return
		}
	}
}
