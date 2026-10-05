// read-image.ts — 给脚本一条直接拿到图片块的路
//
// 上游规则：声明了 outputSchema 的工具，脚本收到 structuredContent；其余工具只收到文本。
// pi 的 read 读图片时返回图片块，却没声明 outputSchema，于是脚本只能拿到
// "Read image file [image/png]" 这行字，模型被迫 base64 + 拼 data URL。
// 这里补一个小工具，把块原样交给脚本：
//
//   const img = await tools.read_image({ path: "/tmp/x.png" });
//   image(img);
//
// 只对脚本可见（exposure: "codemode"），不进模型直接调用的工具列表。

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { Type } from "typebox";

export const READ_IMAGE_SCHEMA = Type.Object({
	path: Type.String({ description: "图片文件路径（png/jpg/jpeg/gif/webp/bmp）" }),
});

/** 脚本会拿到的那个块：与上游 image() 认的形状一致 */
export const IMAGE_BLOCK_SCHEMA = Type.Object({
	type: Type.Literal("image"),
	data: Type.String({ description: "base64，不带 data: 前缀" }),
	mimeType: Type.String(),
});

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

/** 图片是按面积吃 token 的：太大就别往上下文里塞 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export interface ReadImageDeps {
	size?: (path: string) => number;
	read?: (path: string) => Buffer;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

/** 读文件 → 图片块；失败给一句人话，脚本里 throw 出去模型看得到 */
export function readImageBlock(
	path: string,
	deps: ReadImageDeps = {},
): { ok: true; block: ImageBlock } | { ok: false; error: string } {
	const size = deps.size ?? ((p: string) => statSync(p).size);
	const read = deps.read ?? ((p: string) => readFileSync(p));
	const ext = extname(String(path ?? "")).toLowerCase();
	const mimeType = MIME_BY_EXT[ext];
	if (!mimeType) return { ok: false, error: `不是认得的图片后缀（png/jpg/jpeg/gif/webp/bmp）：${path}` };
	const bytes = size(path);
	if (bytes > MAX_IMAGE_BYTES) {
		return {
			ok: false,
			error: `图片 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限；先缩小再读`
		};
	}
	return { ok: true, block: { type: "image", data: read(path).toString("base64"), mimeType } };
}
