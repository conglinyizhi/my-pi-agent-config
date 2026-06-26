/**
 * LPK 应用后端 esbuild 单文件打包模式
 *
 * 用法（package.json scripts）：
 *   "build": "export BUILD_ID=$(node -p 'Date.now()') && pnpm run build:server-bundle && pnpm run build:client && pnpm run build:copy-assets",
 *   "build:server-bundle": "esbuild src/server/index.ts --bundle --platform=node --format=cjs --outfile=dist/server-bundle.cjs --tsconfig=tsconfig.server.json --define:BUILD_ID=\\\"$BUILD_ID\\\""
 *
 * 注意 --define 的转义：
 *   JSON 解析后 → shell 展开 $BUILD_ID → esbuild 收到 "BUILD_ID 替换为 \"时间戳\""
 *   如果 BUILD_ID 是空字符串，替换后的 typeof BUILD_ID !== 'undefined' 仍为 true（值为 ""）
 *   需同时检查真值：typeof BUILD_ID !== 'undefined' && BUILD_ID ? BUILD_ID : 'dev'
 *
 * 启动（scripts/setup.sh）：
 *   #!/bin/sh
 *   set -e
 *   exec node /lzcapp/pkg/content/server-bundle.cjs
 *
 * LPK 包体：源码 ~200KB → bundle ~2MB（消除 node_modules 207MB 的运行时依赖）
 */

// ---- 后端入口 index.ts ----
import { createServer } from 'http';
import { createApp } from './app.js';
import { config } from './config.js';

// esbuild --define 注入的构建 ID，开发时默认 'dev'
declare const BUILD_ID: string;
const SERVER_BUILD_ID: string =
  typeof BUILD_ID !== 'undefined' && BUILD_ID ? BUILD_ID : 'dev';

const app = createApp(deps);
const server = createServer();
server.on('request', app);

server.listen(config.PORT, () => {
  console.log(`Server listening on port ${config.PORT}`);
});
