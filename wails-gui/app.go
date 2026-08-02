package main

import (
	"encoding/json"
	"os"
)

// App 是对应 gui-kit.mjs 的 Go 侧实现：
//   inject()          -> GetInitData()
//   fs.writeFileSync  -> SaveResponse()
type App struct {
	requestFile  string
	responseFile string
}

func NewApp(requestFile, responseFile string) *App {
	return &App{requestFile: requestFile, responseFile: responseFile}
}

// GetInitData 读取 request 文件并返回注入数据（对齐原 app.ts 的 inject 输出结构）
func (a *App) GetInitData() (map[string]interface{}, error) {
	data, err := os.ReadFile(a.requestFile)
	if err != nil {
		return map[string]interface{}{}, err
	}
	var req map[string]interface{}
	if err := json.Unmarshal(data, &req); err != nil {
		return map[string]interface{}{}, err
	}
	return map[string]interface{}{
		"models":       req["models"],
		"roles":        req["roles"],
		"responseFile": a.responseFile,
	}, nil
}

// SaveResponse 写响应文件（对齐 fs.writeFileSync(responseFile, JSON.stringify(payload))）
func (a *App) SaveResponse(payload string) error {
	return os.WriteFile(a.responseFile, []byte(payload), 0644)
}
