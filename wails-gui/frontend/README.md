# Wails GUI Frontend

Vue 3 + Vite frontend shared by the Wails desktop binary and a browser portability shell.

## Desktop build

From `wails-gui/`:

```bash
wails build -tags webkit2_41
```

## Browser mock shell

`browser.html` runs the same Vue views with static fixtures and `platform/browser.js`, without Wails bindings or a real server. It is a portability check, not a permission or agent backend.

```bash
pnpm build:browser
pnpm dev
```

Open one of:

```text
/browser.html?view=gate
/browser.html?view=subagents
/browser.html?view=routing
/browser.html?view=editor
```

The browser adapter mirrors the Wails platform interface. A future Web service should replace fixture methods with HTTP/SSE while preserving the Vue/domain layers.
