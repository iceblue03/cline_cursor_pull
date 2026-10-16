import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorImportAdapter } from "./cursor";

describe("CursorImportAdapter unit tests", () => {
	it("returns false for isInstalled when directory does not exist", () => {
		const tempDir = join(tmpdir(), `test-cursor-missing-${Date.now()}`);
		const adapter = new CursorImportAdapter({ userDir: tempDir });
		expect(adapter.isInstalled()).toBe(false);
	});

	it("returns empty array for discover when not installed", () => {
		const tempDir = join(tmpdir(), `test-cursor-missing-${Date.now()}`);
		const adapter = new CursorImportAdapter({ userDir: tempDir });
		expect(adapter.discover()).toEqual([]);
	});

	it("throws when convert is called on non-existent session", () => {
		const tempDir = join(tmpdir(), `test-cursor-missing-${Date.now()}`);
		const adapter = new CursorImportAdapter({ userDir: tempDir });
		expect(() => adapter.convert("composer:nonexistent")).toThrow("Cursor session composer:nonexistent not found");
	});
});
