import { describe, expect, it } from "bun:test";
import { cursorUserDir } from "./paths";

describe("cursorUserDir", () => {
	it("uses CURSOR_USER_DIR environment variable if provided", () => {
		const env = { CURSOR_USER_DIR: "/custom/cursor/path" };
		const result = cursorUserDir({
			platform: "linux",
			homeDir: "/home/user",
			env,
			joinPath: (...paths) => paths.join("/"),
		});
		expect(result).toBe("/custom/cursor/path");
	});

	it("resolves darwin (macOS) default path", () => {
		const result = cursorUserDir({
			platform: "darwin",
			homeDir: "/Users/testuser",
			env: {},
			joinPath: (...paths) => paths.join("/"),
		});
		expect(result).toBe("/Users/testuser/Library/Application Support/Cursor/User");
	});

	it("resolves win32 default path with APPDATA", () => {
		const result = cursorUserDir({
			platform: "win32",
			homeDir: "C:\\Users\\testuser",
			env: { APPDATA: "C:\\Users\\testuser\\AppData\\Roaming" },
			joinPath: (...paths) => paths.join("\\"),
		});
		expect(result).toBe("C:\\Users\\testuser\\AppData\\Roaming\\Cursor\\User");
	});

	it("resolves linux default path with XDG_CONFIG_HOME", () => {
		const result = cursorUserDir({
			platform: "linux",
			homeDir: "/home/testuser",
			env: { XDG_CONFIG_HOME: "/home/testuser/.config" },
			joinPath: (...paths) => paths.join("/"),
		});
		expect(result).toBe("/home/testuser/.config/Cursor/User");
	});

	it("resolves linux default path fallback without XDG_CONFIG_HOME", () => {
		const result = cursorUserDir({
			platform: "linux",
			homeDir: "/home/testuser",
			env: {},
			joinPath: (...paths) => paths.join("/"),
		});
		expect(result).toBe("/home/testuser/.config/Cursor/User");
	});
});
