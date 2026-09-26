package main

import (
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// windowConfig 对应 gui-kit 各 app.ts 的 createGuiApp 配置
type windowConfig struct {
	title  string
	width  int
	height int
	// 最小尺寸交给窗口管理器兜：面板多的窗口（审批窗的执行范围、规则列表）
	// 被拖得太小会挤成一团，前端自己算最小宽高既难准也晚一步
	minWidth  int
	minHeight int
}

var windowConfigs = map[string]windowConfig{
	"editor":    {"提示词输入 · pi", 900, 620, 720, 480},
	"gate":      {"权限闸门 · 命令审批", 1280, 900, 960, 640},
	"subagents": {"Subagent 详情 · 三叉戟", 1280, 860, 900, 600},
	"routing":   {"TODO 调度 · 三叉戟", 1000, 720, 800, 540},
}

func main() {
	// CLI: pi-gui <window-name> <request.json> <response.json>
	args := os.Args[1:]
	windowName := "gate"
	requestFile := ""
	responseFile := ""
	if len(args) >= 3 {
		windowName = args[0]
		requestFile = args[1]
		responseFile = args[2]
	}

	cfg, ok := windowConfigs[windowName]
	if !ok {
		println("unknown window:", windowName)
		os.Exit(1)
	}

	app := NewApp(windowName, requestFile, responseFile)

	err := wails.Run(&options.App{
		Title:     cfg.title,
		Width:     cfg.width,
		Height:    cfg.height,
		MinWidth:  cfg.minWidth,
		MinHeight: cfg.minHeight,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
