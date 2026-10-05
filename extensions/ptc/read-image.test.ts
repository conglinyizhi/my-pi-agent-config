import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_IMAGE_BYTES, readImageBlock } from "./read-image.ts";

const deps = (bytes: number) => ({ size: () => bytes, read: () => Buffer.from("png-bytes") });

describe("read_image 工具", () => {
	it("png 读成图片块，data 是不带前缀的 base64", () => {
		const result = readImageBlock("/tmp/x.png", deps(1024));
		assert.equal(result.ok, true);
		assert.equal(result.block.mimeType, "image/png");
		assert.equal(result.block.type, "image");
		assert.equal(result.block.data, Buffer.from("png-bytes").toString("base64"));
	});

	it("不是图片后缀就报错，不去猜", () => {
		const result = readImageBlock("/tmp/notes.txt", deps(10));
		assert.equal(result.ok, false);
		assert.match(result.error, /不是认得的图片后缀/);
	});

	it("超过上限就拒绝，并告诉调用方先缩小", () => {
		const result = readImageBlock("/tmp/big.png", deps(MAX_IMAGE_BYTES + 1));
		assert.equal(result.ok, false);
		assert.match(result.error, /超过 .*上限/);
	});
});
