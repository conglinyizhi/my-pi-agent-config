// gui/electron/preload.cjs — 渲染进程能看到的唯一宿主接口
//
// 前端 platform/electron.js 照着这里调用；别在视图里直接碰 ipcRenderer。
// 用 .cjs 是因为本目录是 type=module，而沙箱下的 preload 不支持 ESM。
const { contextBridge, ipcRenderer } = require("electron");

const call = (name, ...args) => ipcRenderer.invoke(`pi-gui:${name}`, ...args);

contextBridge.exposeInMainWorld("piGui", {
	session: {
		getWindowName: () => call("windowName"),
		getInitData: () => call("initData"),
		markReady: () => call("markReady"),
		submit: (response) => call("submit", response),
		close: () => call("close"),
	},
	capabilities: {
		openFile: (file, line) => call("openFile", file, line),
		copyText: (text) => call("copyText", text),
	},
	gate: {
		loadReasons: () => call("reasons:load"),
		saveReason: (content) => call("reasons:save", content),
		updateReason: (oldContent, newContent) => call("reasons:update", oldContent, newContent),
		deleteReason: (content) => call("reasons:delete", content),
	},
	review: {
		load: () => call("review:load"),
		save: (patch) => call("review:save", patch),
	},
	rules: {
		get: () => call("rules:get"),
		save: (patch) => call("rules:save", patch),
	},
	flows: {
		list: () => call("flows:list"),
		get: (id) => call("flows:get", id),
		save: (patch) => call("flows:save", patch),
		editEdge: (patch) => call("flows:editEdge", patch),
		addNode: (patch) => call("flows:addNode", patch),
		removeEdge: (patch) => call("flows:removeEdge", patch),
	},
	editor: {
		list: () => call("editor:list"),
		open: (payload) => call("editor:open", payload),
	},
	subagents: {
		getStatus: (statusPath) => call("subagents:status", statusPath),
		getDiagnostics: () => call("subagents:diagnostics"),
		getDiagnostic: (file) => call("subagents:diagnostic", file),
		deleteDiagnostic: (file) => call("subagents:diagnostic:delete", file),
		queueSupplement: (payload) => call("subagents:queueSupplement", payload),
		withdrawSupplement: (payload) => call("subagents:withdrawSupplement", payload),
		mergeSupplements: (payload) => call("subagents:mergeSupplements", payload),
	},
});
