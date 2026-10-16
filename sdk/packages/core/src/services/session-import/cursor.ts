import { copyFileSync, existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as LlmsProviders from "@cline/llms";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { nanoid } from "nanoid";
import { cursorUserDir } from "./paths";
import {
	type ConvertedImportedSession,
	type ImportableSessionSummary,
	type SessionImportAdapter,
	truncateForDisplay,
} from "./types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseData(value: unknown): JsonRecord | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function asMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
		const num = Number(value);
		if (Number.isFinite(num) && num > 0) return num;
	}
	return undefined;
}

function fileUriToPath(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	try {
		const url = new URL(uri);
		let pathname = decodeURIComponent(url.pathname);
		if (process.platform === "win32" && pathname.startsWith("/") && pathname.charAt(2) === ":") {
			pathname = pathname.slice(1);
		}
		return pathname;
	} catch {
		return uri.replace(/^file:\/\//, "");
	}
}

export interface CursorAdapterOptions {
	/** Defaults to $CURSOR_USER_DIR or platform-specific User directory */
	userDir?: string;
}

interface DiscoveredSessionInternal {
	sourceId: string;
	dbPath: string;
	type: "composer" | "chat";
	title: string;
	cwd: string;
	startedAtMs: number;
	updatedAtMs: number;
	rawSessionData: JsonRecord;
}

export class CursorImportAdapter implements SessionImportAdapter {
	readonly tool = "cursor" as const;
	private readonly userDir: string;
	private readonly globalDbPath: string;
	private readonly workspaceStorageDir: string;

	constructor(options: CursorAdapterOptions = {}) {
		this.userDir = options.userDir ?? cursorUserDir();
		this.globalDbPath = join(this.userDir, "globalStorage", "state.vscdb");
		this.workspaceStorageDir = join(this.userDir, "workspaceStorage");
	}

	isInstalled(): boolean {
		return existsSync(this.globalDbPath) || existsSync(this.workspaceStorageDir);
	}

	private snapshots = new Map<string, { dir: string; db: SqliteDb }>();

	private openSnapshot(dbPath: string): SqliteDb {
		const existing = this.snapshots.get(dbPath);
		if (existing) return existing.db;

		const dir = mkdtempSync(join(tmpdir(), "cline-cursor-import-"));
		try {
			const copied = join(dir, "state.vscdb");
			copyFileSync(dbPath, copied);
			for (const suffix of ["-wal", "-shm"]) {
				const sidecarFile = `${dbPath}${suffix}`;
				if (existsSync(sidecarFile)) {
					copyFileSync(sidecarFile, `${copied}${suffix}`);
				}
			}
			const db = loadSqliteDb(copied);
			this.snapshots.set(dbPath, { dir, db });
			return db;
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
	}

	dispose(): void {
		for (const snapshot of this.snapshots.values()) {
			try {
				snapshot.db.close?.();
			} finally {
				rmSync(snapshot.dir, { recursive: true, force: true });
			}
		}
		this.snapshots.clear();
	}

	private listAllDbPaths(): { dbPath: string; cwd: string }[] {
		const list: { dbPath: string; cwd: string }[] = [];
		if (existsSync(this.globalDbPath)) {
			list.push({ dbPath: this.globalDbPath, cwd: "" });
		}

		if (existsSync(this.workspaceStorageDir)) {
			try {
				const entries = readdirSync(this.workspaceStorageDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const folderPath = join(this.workspaceStorageDir, entry.name);
					const dbPath = join(folderPath, "state.vscdb");
					if (!existsSync(dbPath)) continue;

					let cwd = "";
					const workspaceJsonPath = join(folderPath, "workspace.json");
					if (existsSync(workspaceJsonPath)) {
						try {
							const content = parseData(readFileSync(workspaceJsonPath, "utf-8"));
							if (content) {
								if (typeof content.folder === "string") {
									cwd = fileUriToPath(content.folder);
								} else if (typeof content.workspace === "string") {
									cwd = fileUriToPath(content.workspace);
								}
							}
						} catch {
							// Ignore workspace.json parse errors
						}
					}
					list.push({ dbPath, cwd });
				}
			} catch {
				// Ignore readdir errors
			}
		}

		return list;
	}

	private discoverFromDb(dbPath: string, defaultCwd: string): DiscoveredSessionInternal[] {
		const sessionMap = new Map<string, DiscoveredSessionInternal>();
		try {
			const db = this.openSnapshot(dbPath);

			const tableCheck = db
				.prepare(`SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='ItemTable'`)
				.get() as { count: number } | undefined;
			if (!tableCheck || tableCheck.count === 0) return [];

			const rows = db.prepare(`SELECT [key], [value] FROM ItemTable`).all() as {
				key: string;
				value: string;
			}[];

			for (const row of rows) {
				const key = String(row.key ?? "");
				const valueStr = String(row.value ?? "");

				// 1. Composer Data
				if (key === "composer.composerData" || key.startsWith("composerData:")) {
					const data = parseData(valueStr);
					if (!data) continue;

					const composersList: JsonRecord[] = [];
					if (Array.isArray(data.allComposers)) {
						for (const item of data.allComposers) {
							if (isRecord(item)) composersList.push(item);
						}
					} else if (Array.isArray(data.composers)) {
						for (const item of data.composers) {
							if (isRecord(item)) composersList.push(item);
						}
					} else if (data.composerId || data.id) {
						composersList.push(data);
					}

					for (const comp of composersList) {
						const composerId = String(comp.composerId ?? comp.id ?? "");
						if (!composerId) continue;

						const sourceId = `composer:${composerId}`;

						const textName = typeof comp.text === "string" ? comp.text.trim() : "";
						const name = typeof comp.name === "string" ? comp.name.trim() : "";
						const title = textName || name || "Cursor Composer Session";

						const createdAt = asMs(comp.createdAt) ?? Date.now();
						const updatedAt = asMs(comp.lastUpdatedAt) ?? asMs(comp.updatedAt) ?? createdAt;

						let cwd = defaultCwd;
						if (typeof comp.workspaceUri === "string") {
							cwd = fileUriToPath(comp.workspaceUri);
						} else if (typeof comp.projectPath === "string") {
							cwd = comp.projectPath;
						}

						const existing = sessionMap.get(sourceId);
						const hasBubbles =
							Array.isArray(comp.fullData?.bubbles) ||
							Array.isArray(comp.bubbles) ||
							Array.isArray(comp.conversation) ||
							Array.isArray(comp.messages);

						if (existing) {
							const mergedRaw = hasBubbles
								? { ...existing.rawSessionData, ...comp }
								: { ...comp, ...existing.rawSessionData };

							sessionMap.set(sourceId, {
								sourceId,
								dbPath,
								type: "composer",
								title: existing.title !== "Cursor Composer Session" ? existing.title : title,
								cwd: existing.cwd || cwd,
								startedAtMs: Math.min(existing.startedAtMs, createdAt),
								updatedAtMs: Math.max(existing.updatedAtMs, updatedAt),
								rawSessionData: mergedRaw,
							});
						} else {
							sessionMap.set(sourceId, {
								sourceId,
								dbPath,
								type: "composer",
								title,
								cwd,
								startedAtMs: createdAt,
								updatedAtMs: updatedAt,
								rawSessionData: comp,
							});
						}
					}
				}

				// 2. Chat Data
				if (
					key.includes("aichat.chatdata") ||
					key.includes("workbench.panel.aichat") ||
					key === "chat.workspaceData"
				) {
					const data = parseData(valueStr);
					if (!data) continue;

					const tabs: JsonRecord[] = [];
					if (Array.isArray(data.tabs)) {
						for (const item of data.tabs) {
							if (isRecord(item)) tabs.push(item);
						}
					}

					for (const tab of tabs) {
						const tabId = String(tab.tabId ?? tab.id ?? tab.chatId ?? "");
						if (!tabId) continue;

						const sourceId = `chat:${tabId}`;
						const rawTitle = typeof tab.title === "string" ? tab.title.trim() : "";
						const title = rawTitle || "Cursor Chat Session";

						const createdAt = asMs(tab.createdAt) ?? asMs(tab.lastSendTime) ?? Date.now();
						const updatedAt = asMs(tab.lastSendTime) ?? asMs(tab.updatedAt) ?? createdAt;

						const existing = sessionMap.get(sourceId);
						if (existing) {
							sessionMap.set(sourceId, {
								sourceId,
								dbPath,
								type: "chat",
								title: existing.title !== "Cursor Chat Session" ? existing.title : title,
								cwd: defaultCwd || existing.cwd,
								startedAtMs: Math.min(existing.startedAtMs, createdAt),
								updatedAtMs: Math.max(existing.updatedAtMs, updatedAt),
								rawSessionData: { ...existing.rawSessionData, ...tab },
							});
						} else {
							sessionMap.set(sourceId, {
								sourceId,
								dbPath,
								type: "chat",
								title,
								cwd: defaultCwd,
								startedAtMs: createdAt,
								updatedAtMs: updatedAt,
								rawSessionData: tab,
							});
						}
					}
				}
			}
		} catch {
			// Best-effort parsing per DB file
		}

		return Array.from(sessionMap.values());
	}

	discover(): ImportableSessionSummary[] {
		if (!this.isInstalled()) return [];

		const allDiscovered: DiscoveredSessionInternal[] = [];
		const dbList = this.listAllDbPaths();

		for (const { dbPath, cwd } of dbList) {
			const found = this.discoverFromDb(dbPath, cwd);
			allDiscovered.push(...found);
		}

		const summaries: ImportableSessionSummary[] = [];

		for (const disc of allDiscovered) {
			const { messages, preview } = this.extractPreviewAndCount(disc);
			if (messages.length === 0) continue;

			const displayPreview = truncateForDisplay(preview);
			const needsFallback = !disc.title || disc.title === "Cursor Composer Session" || disc.title === "Cursor Chat Session";

			summaries.push({
				tool: this.tool,
				sourceId: disc.sourceId,
				sourcePath: disc.dbPath,
				title:
					(needsFallback ? truncateForDisplay(preview, 120) : undefined) ??
					truncateForDisplay(disc.title, 120) ??
					"Untitled Cursor session",
				cwd: disc.cwd,
				startedAtMs: disc.startedAtMs,
				updatedAtMs: disc.updatedAtMs,
				messageCount: messages.length,
				...(displayPreview ? { preview: displayPreview } : {}),
			});
		}

		return summaries;
	}

	private extractPreviewAndCount(disc: DiscoveredSessionInternal): {
		messages: LlmsProviders.MessageWithMetadata[];
		preview?: string;
	} {
		const converted = this.convertInternal(disc);
		let preview: string | undefined;
		for (const msg of converted.messages) {
			if (msg.role === "user") {
				for (const block of msg.content) {
					if (block.type === "text" && block.text.trim()) {
						preview = block.text;
						break;
					}
				}
			}
			if (preview) break;
		}
		return { messages: converted.messages, preview };
	}

	convert(sourceId: string): ConvertedImportedSession {
		const dbList = this.listAllDbPaths();
		for (const { dbPath, cwd } of dbList) {
			const found = this.discoverFromDb(dbPath, cwd);
			const matched = found.find((item) => item.sourceId === sourceId);
			if (matched) {
				return this.convertInternal(matched);
			}
		}

		throw new Error(`Cursor session ${sourceId} not found`);
	}

	private convertInternal(disc: DiscoveredSessionInternal): ConvertedImportedSession {
		const messages: LlmsProviders.MessageWithMetadata[] = [];
		let prompt: string | undefined;
		let endedAtMs: number | undefined;

		const data = disc.rawSessionData;

		const rawBubbles: JsonRecord[] = [];
		if (Array.isArray(data.fullData?.bubbles)) {
			for (const b of data.fullData.bubbles) if (isRecord(b)) rawBubbles.push(b);
		} else if (Array.isArray(data.bubbles)) {
			for (const b of data.bubbles) if (isRecord(b)) rawBubbles.push(b);
		} else if (Array.isArray(data.conversation)) {
			for (const b of data.conversation) if (isRecord(b)) rawBubbles.push(b);
		} else if (Array.isArray(data.messages)) {
			for (const b of data.messages) if (isRecord(b)) rawBubbles.push(b);
		}

		for (const bubble of rawBubbles) {
			const typeVal = bubble.type ?? bubble.role;
			const isUser =
				typeVal === "user" ||
				typeVal === 1 ||
				typeVal === "USER" ||
				bubble.type === "user";

			const ts = asMs(bubble.timestamp) ?? asMs(bubble.createdAt) ?? asMs(bubble.time);
			if (ts) endedAtMs = ts;

			const textContent =
				typeof bubble.text === "string"
					? bubble.text
					: typeof bubble.content === "string"
					? bubble.content
					: typeof bubble.rawText === "string"
					? bubble.rawText
					: "";

			if (isUser) {
				const userBlocks: LlmsProviders.ContentBlock[] = [];
				if (textContent.trim()) {
					userBlocks.push({ type: "text", text: textContent });
					prompt = prompt ?? textContent;
				}

				const images = Array.isArray(bubble.images)
					? bubble.images
					: Array.isArray(bubble.attachedImages)
					? bubble.attachedImages
					: [];

				for (const img of images) {
					if (typeof img === "string") {
						if (img.startsWith("data:")) {
							const parts = img.split(",", 2);
							const mime = parts[0]?.split(";")[0]?.replace("data:", "") || "image/png";
							if (parts[1]) {
								userBlocks.push({ type: "image", data: parts[1], mediaType: mime });
							}
						}
					} else if (isRecord(img)) {
						const dataStr = typeof img.data === "string" ? img.data : typeof img.base64 === "string" ? img.base64 : "";
						const mime = typeof img.mime === "string" ? img.mime : typeof img.mediaType === "string" ? img.mediaType : "image/png";
						if (dataStr) {
							const cleanData = dataStr.includes(",") ? dataStr.split(",", 2)[1] : dataStr;
							if (cleanData) {
								userBlocks.push({ type: "image", data: cleanData, mediaType: mime });
							}
						}
					}
				}

				if (userBlocks.length > 0) {
					messages.push({
						role: "user",
						content: userBlocks,
						...(ts ? { ts } : {}),
					});
				}
			} else {
				const assistantBlocks: LlmsProviders.ContentBlock[] = [];

				const thinkingText =
					typeof bubble.thought === "string"
						? bubble.thought
						: typeof bubble.thinking === "string"
						? bubble.thinking
						: typeof bubble.reasoning === "string"
						? bubble.reasoning
						: "";

				if (thinkingText.trim()) {
					assistantBlocks.push({ type: "thinking", thinking: thinkingText });
				}

				if (textContent.trim()) {
					assistantBlocks.push({ type: "text", text: textContent });
				}

				if (Array.isArray(bubble.codeBlocks)) {
					for (const cb of bubble.codeBlocks) {
						if (isRecord(cb) && typeof cb.code === "string" && cb.code.trim()) {
							const lang = typeof cb.language === "string" ? cb.language : "";
							const codeText = `\`\`\`${lang}\n${cb.code}\n\`\`\``;
							assistantBlocks.push({ type: "text", text: codeText });
						}
					}
				}

				if (assistantBlocks.length > 0) {
					const modelName = typeof bubble.modelType === "string" ? bubble.modelType : "cursor";
					messages.push({
						role: "assistant",
						content: assistantBlocks,
						modelInfo: { id: modelName, provider: "cursor" },
						...(ts ? { ts } : {}),
					});
				}
			}
		}

		const needsFallback = !disc.title || disc.title === "Cursor Composer Session" || disc.title === "Cursor Chat Session";
		const displayPrompt = truncateForDisplay(prompt, 2000);

		return {
			tool: this.tool,
			sourceId: disc.sourceId,
			sourcePath: disc.dbPath,
			title:
				(needsFallback ? truncateForDisplay(prompt, 120) : undefined) ??
				truncateForDisplay(disc.title, 120) ??
				"Untitled Cursor session",
			...(displayPrompt ? { prompt: displayPrompt } : {}),
			provider: "cursor",
			model: "cursor",
			cwd: disc.cwd,
			startedAtMs: disc.startedAtMs,
			endedAtMs: endedAtMs ?? disc.updatedAtMs,
			messages,
		};
	}
}
