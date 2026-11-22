import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import { findMixpanelTool, mixpanelCore } from "./core";
import { MixpanelTimeoutError } from "./errors";
import { runMixpanelLogin } from "./login";
import mixpanelToolDescription from "./prompts/mixpanel-tool.md" with { type: "text" };
import {
	MIXPANEL_SIGN_IN_GUIDANCE,
	MIXPANEL_UNTRUSTED_DATA_NOTICE,
	isJsonRecord,
	mixpanelErrorText,
	renderMcpResult,
	renderMcpResultForArtifact,
	renderMixpanelStatus,
	renderMixpanelToolList,
	renderMixpanelToolSchema,
	spillRenderedText,
} from "./render";
import { DEFAULT_MIXPANEL_TIMEOUT_MS, MIXPANEL_REGIONS } from "./types";
import type { MixpanelAccount, MixpanelCallOptions, MixpanelCore, MixpanelRegion } from "./types";

const DEVICE_OPS = ["call", "batch", "tools", "schema", "login", "status"] as const;
export type MixpanelToolOperation = (typeof DEVICE_OPS)[number];

export interface MixpanelBatchCall {
	tool: string;
	args?: Record<string, unknown>;
}

export interface MixpanelToolInput {
	op?: MixpanelToolOperation;
	tool?: string;
	tools?: string[];
	args?: Record<string, unknown>;
	region?: MixpanelRegion;
	timeout?: number;
	calls?: MixpanelBatchCall[];
	concurrency?: number;
}

export interface MixpanelOperationOptions {
	login?: (region?: MixpanelRegion) => Promise<MixpanelAccount>;
	signal?: AbortSignal;
	saveArtifact?: (content: string) => Promise<string | undefined>;
}

export interface MixpanelBatchCallResult {
	tool: string;
	ok: boolean;
	error?: string;
	structuredContent?: unknown;
}

export interface MixpanelToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		ok: boolean;
		error?: string;
		structuredContent?: unknown;
		artifact?: string;
		results?: MixpanelBatchCallResult[];
	};
	isError?: boolean;
}

interface PreparedBatchCall {
	requestedTool: string;
	args: Record<string, unknown>;
}

type MixpanelCallOutcome =
	| { ok: true; result: MCPToolCallResult }
	| { ok: false; error: string; result?: MCPToolCallResult };

type SaveArtifact = NonNullable<MixpanelOperationOptions["saveArtifact"]>;

function textResult(text: string): MixpanelToolResult {
	return { content: [{ type: "text", text }], details: { ok: true } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message || error.name : String(error);
}

function throwIfAborted(error: unknown, signal?: AbortSignal): void {
	if (signal?.aborted) {
		if (signal.reason !== undefined) throw signal.reason;
		if (error !== null && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
		throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
	}
	if (error !== null && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
}

function errorResult(error: string): MixpanelToolResult {
	return {
		content: [{ type: "text", text: error }],
		isError: true,
		details: { ok: false, error },
	};
}

async function renderedTextResult(
	inlineText: string,
	fullText: string,
	details: MixpanelToolResult["details"],
	saveArtifact?: SaveArtifact,
	isError = false,
): Promise<MixpanelToolResult> {
	const rendered = await spillRenderedText(inlineText, fullText, saveArtifact);
	return {
		content: [{ type: "text", text: rendered.text }],
		details: { ...details, ...(rendered.artifact ? { artifact: rendered.artifact } : {}) },
		...(isError ? { isError: true } : {}),
	};
}

async function requireMixpanelTool(
	core: MixpanelCore,
	name: string | undefined,
	operation: string,
	signal?: AbortSignal,
): Promise<MCPToolDefinition> {
	const requested = name?.trim();
	if (!requested) throw new Error(`Mixpanel MCP "${operation}" operation requires a tool name.`);
	const tools = await core.listTools(signal);
	const tool = findMixpanelTool(tools, requested);
	if (!tool) {
		throw new Error(`Mixpanel MCP has no tool "${requested}". Available tools: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`);
	}
	return tool;
}

function timeoutMilliseconds(timeout: number | undefined): number {
	if (timeout === undefined) return DEFAULT_MIXPANEL_TIMEOUT_MS;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
		throw new Error('Mixpanel MCP "timeout" must be an integer from 1 to 600 seconds.');
	}
	return timeout * 1_000;
}

async function callMixpanelTool(
	core: MixpanelCore,
	name: string,
	args: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<MixpanelCallOutcome> {
	const options: MixpanelCallOptions = { signal, timeoutMs };
	let result: MCPToolCallResult;
	try {
		result = await core.callTool(name, args, options);
	} catch (error) {
		throwIfAborted(error, signal);
		if (!(error instanceof MixpanelTimeoutError) || !isReadOnlyMixpanelTool(name)) {
			return { ok: false, error: errorMessage(error) };
		}
		try {
			result = await core.callTool(name, args, options);
		} catch (retryError) {
			throwIfAborted(retryError, signal);
			const message = errorMessage(retryError);
			return {
				ok: false,
				error: retryError instanceof MixpanelTimeoutError
					? `${message} (read-only call was retried once; retry also timed out).`
					: message,
			};
		}
	}
	if (result.isError) return { ok: false, error: mixpanelErrorText(result), result };
	return { ok: true, result };
}

function callOutcomeBody(outcome: MixpanelCallOutcome, pretty: boolean): string {
	if (outcome.ok) return pretty ? renderMcpResultForArtifact(outcome.result) : renderMcpResult(outcome.result);
	if (outcome.result) return pretty ? renderMcpResultForArtifact(outcome.result) : renderMcpResult(outcome.result);
	return outcome.error;
}

function callOutcomeDetails(outcome: MixpanelCallOutcome): MixpanelToolResult["details"] {
	return {
		ok: outcome.ok,
		...(!outcome.ok ? { error: outcome.error } : {}),
		...(outcome.result?.structuredContent === undefined ? {} : { structuredContent: outcome.result.structuredContent }),
	};
}

async function executeCall(
	core: MixpanelCore,
	input: MixpanelToolInput,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	saveArtifact: SaveArtifact | undefined,
): Promise<MixpanelToolResult> {
	const tool = await requireMixpanelTool(core, input.tool, "call", signal);
	const outcome = await callMixpanelTool(core, tool.name, input.args ?? {}, timeoutMs, signal);
	const inlineText = `${MIXPANEL_UNTRUSTED_DATA_NOTICE}\n\n${callOutcomeBody(outcome, false)}`;
	const fullText = `${MIXPANEL_UNTRUSTED_DATA_NOTICE}\n\n${callOutcomeBody(outcome, true)}`;
	return renderedTextResult(inlineText, fullText, callOutcomeDetails(outcome), saveArtifact, !outcome.ok);
}

function normalizeBatchCalls(calls: unknown): PreparedBatchCall[] {
	if (!Array.isArray(calls) || calls.length < 1 || calls.length > 100) {
		throw new Error('Mixpanel MCP "batch" operation requires 1 to 100 calls.');
	}
	return calls.map((call, index) => {
		if (
			!isJsonRecord(call)
			|| (Object.getPrototypeOf(call) !== Object.prototype && Object.getPrototypeOf(call) !== null)
			|| Object.keys(call).some(key => key !== "tool" && key !== "args")
		) {
			throw new Error(`Mixpanel MCP "batch" call ${index + 1} must contain only "tool" and optional "args".`);
		}
		const requestedTool = typeof call.tool === "string" ? call.tool.trim() : "";
		if (!requestedTool) throw new Error(`Mixpanel MCP "batch" call ${index + 1} requires a tool name.`);
		const args = call.args === undefined ? {} : call.args;
		if (
			!isJsonRecord(args)
			|| (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)
		) {
			throw new Error(`Mixpanel MCP "batch" call ${index + 1} args must be an object.`);
		}
		return { requestedTool, args };
	});
}

async function executeBatch(
	core: MixpanelCore,
	input: MixpanelToolInput,
	signal: AbortSignal | undefined,
	saveArtifact: SaveArtifact | undefined,
): Promise<MixpanelToolResult> {
	const calls = normalizeBatchCalls(input.calls);
	const timeoutMs = timeoutMilliseconds(input.timeout);
	const concurrency = input.concurrency ?? 4;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
		throw new Error('Mixpanel MCP "concurrency" must be an integer from 1 to 8.');
	}

	const tools = await core.listTools(signal);
	const resolved = calls.map(call => ({
		...call,
		tool: findMixpanelTool(tools, call.requestedTool),
	}));
	const unknown = resolved.filter(call => !call.tool).map(call => call.requestedTool);
	if (unknown.length > 0) {
		throw new Error(`Mixpanel MCP "batch" has unknown tool(s): ${unknown.map(name => `"${name}"`).join(", ")}. Available tools: ${tools.map(tool => tool.name).join(", ") || "none"}.`);
	}

	const outcomes: MixpanelCallOutcome[] = new Array(resolved.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			throwIfAborted(undefined, signal);
			const index = nextIndex++;
			if (index >= resolved.length) return;
			const call = resolved[index]!;
			outcomes[index] = await callMixpanelTool(core, call.tool!.name, call.args, timeoutMs, signal);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, () => worker()));

	const batchResults = resolved.map((call, index): MixpanelBatchCallResult => {
		const outcome = outcomes[index]!;
		return {
			tool: call.tool!.name,
			ok: outcome.ok,
			...(!outcome.ok ? { error: outcome.error } : {}),
			...(outcome.result?.structuredContent === undefined ? {} : { structuredContent: outcome.result.structuredContent }),
		};
	});
	const ok = batchResults.every(result => result.ok);
	const renderBatch = (pretty: boolean): string => [
		MIXPANEL_UNTRUSTED_DATA_NOTICE,
		...resolved.map((call, index) => {
			const outcome = outcomes[index]!;
			const header = `### [${index + 1}] ${call.tool!.name} — ${outcome.ok ? "ok" : "error"}`;
			return `${header}\n\n${callOutcomeBody(outcome, pretty)}`;
		}),
	].join("\n\n");
	return renderedTextResult(renderBatch(false), renderBatch(true), { ok, results: batchResults }, saveArtifact, !ok);
}

async function executeSchema(
	core: MixpanelCore,
	input: MixpanelToolInput,
	signal: AbortSignal | undefined,
	saveArtifact: SaveArtifact | undefined,
): Promise<MixpanelToolResult> {
	if (input.tool !== undefined && input.tools !== undefined) {
		throw new Error('Mixpanel MCP "schema" accepts either "tool" or "tools", not both.');
	}
	const requestedNames = input.tools ?? (input.tool === undefined ? [] : [input.tool]);
	if (requestedNames.length === 0 || requestedNames.some(name => !name.trim())) {
		throw new Error('Mixpanel MCP "schema" operation requires a tool name or a non-empty "tools" list.');
	}
	const tools = await core.listTools(signal);
	const resolved = requestedNames.map(name => findMixpanelTool(tools, name.trim()));
	const unknown = requestedNames.filter((_, index) => !resolved[index]);
	if (unknown.length > 0) {
		throw new Error(`Mixpanel MCP "schema" has unknown tool(s): ${unknown.map(name => `"${name}"`).join(", ")}. Available tools: ${tools.map(tool => tool.name).join(", ") || "none"}.`);
	}
	const body = resolved.map(tool => renderMixpanelToolSchema(tool!)).join("\n\n---\n\n");
	return renderedTextResult(body, body, { ok: true }, saveArtifact);
}

/** Dispatch one generic operation to Mixpanel's hosted MCP server. */
export async function executeMixpanelOperation(
	core: MixpanelCore,
	input: MixpanelToolInput,
	{ login, signal, saveArtifact }: MixpanelOperationOptions = {},
): Promise<MixpanelToolResult> {
	try {
		switch (input.op ?? "call") {
			case "login": {
				if (!login) throw new Error("Mixpanel sign-in cannot be presented here; run `/mixpanel login [us|eu|in]`.");
				const account = await login(input.region);
				return textResult(renderMixpanelStatus(account, (await core.listTools(signal)).length));
			}
			case "status": {
				const account = await core.account();
				if (!account) return textResult(MIXPANEL_SIGN_IN_GUIDANCE);
				return textResult(renderMixpanelStatus(account, (await core.listTools(signal)).length));
			}
			case "tools":
				return textResult(renderMixpanelToolList(await core.listTools(signal)));
			case "schema":
				return await executeSchema(core, input, signal, saveArtifact);
			case "call":
				return await executeCall(core, input, timeoutMilliseconds(input.timeout), signal, saveArtifact);
			case "batch":
				return await executeBatch(core, input, signal, saveArtifact);
			default:
				throw new Error(`Unknown Mixpanel MCP operation "${String(input.op)}".`);
		}
	} catch (error) {
		throwIfAborted(error, signal);
		return errorResult(errorMessage(error));
	}
}

/** Only clearly read-oriented Mixpanel tools skip write approval. */
const READ_ONLY_MIXPANEL_TOOL = /^(?:Get|List|Search|Describe|Display|Find|Explain)-|^(?:Run-Query|Run-Experiment-Pre-Launch-Checks)$/u;

export function isReadOnlyMixpanelTool(name: string): boolean {
	return READ_ONLY_MIXPANEL_TOOL.test(name.trim());
}

function isValidBatchApproval(args: Record<string, unknown>): boolean {
	if (Object.keys(args).some(key => key !== "op" && key !== "calls" && key !== "timeout" && key !== "concurrency")) return false;
	if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isInteger(args.timeout) || args.timeout < 1 || args.timeout > 600)) {
		return false;
	}
	if (args.concurrency !== undefined && (typeof args.concurrency !== "number" || !Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8)) {
		return false;
	}
	if (!Array.isArray(args.calls) || args.calls.length < 1 || args.calls.length > 100) return false;
	return args.calls.every(call => {
		if (
			!isJsonRecord(call)
			|| (Object.getPrototypeOf(call) !== Object.prototype && Object.getPrototypeOf(call) !== null)
			|| Object.keys(call).some(key => key !== "tool" && key !== "args")
		) {
			return false;
		}
		const callArgs = call.args;
		return typeof call.tool === "string"
			&& call.tool.trim().length > 0
			&& (callArgs === undefined || (
				isJsonRecord(callArgs)
				&& (Object.getPrototypeOf(callArgs) === Object.prototype || Object.getPrototypeOf(callArgs) === null)
			));
	});
}

export function mixpanelApproval(args: unknown): "read" | "write" {
	if (
		!isJsonRecord(args)
		|| (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)
	) {
		return "write";
	}
	const { op = "call", tool } = args as MixpanelToolInput;
	if (op === "tools" || op === "schema" || op === "status") return "read";
	if (op === "batch") {
		return isValidBatchApproval(args)
			&& (args.calls as MixpanelBatchCall[]).every(call => isReadOnlyMixpanelTool(call.tool))
			? "read"
			: "write";
	}
	return op === "call" && typeof tool === "string" && isReadOnlyMixpanelTool(tool) ? "read" : "write";
}

/** A discoverable Mixpanel device; individual tool schemas arrive only through `schema`. */
export function registerMixpanelTool(pi: ExtensionAPI, core: MixpanelCore = mixpanelCore): void {
	const z = pi.zod;
	pi.registerTool({
		name: "mixpanel",
		label: "Mixpanel",
		description: mixpanelToolDescription.trim(),
		loadMode: "discoverable",
		approval: mixpanelApproval,
		parameters: z
			.object({
				op: z.enum([...DEVICE_OPS]).default("call"),
				tool: z.string().optional().describe("Mixpanel MCP tool name; required for call and for a single-tool schema."),
				tools: z.array(z.string()).optional().describe("schema: Mixpanel MCP tool names whose schemas should be returned together."),
				args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the named Mixpanel MCP tool, per its schema."),
				region: z.enum([...MIXPANEL_REGIONS]).optional().describe("login: Mixpanel data region (us, eu, or in)."),
				timeout: z.number().int().min(1).max(600).optional().describe("call or batch: per-request timeout in seconds (1–600; default 120); read-only calls retry once after timeout."),
				calls: z.array(z.object({
					tool: z.string().describe("Exact Mixpanel MCP tool name."),
					args: z.record(z.string(), z.unknown()).optional().describe("Arguments for this Mixpanel MCP tool."),
				}).strict()).min(1).max(100).optional().describe("batch: 1–100 Mixpanel tool calls to run independently."),
				concurrency: z.number().int().min(1).max(8).optional().describe("batch: maximum simultaneous calls (1–8; default 4)."),
			})
			.strict(),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeMixpanelOperation(core, params, {
				login: region => runMixpanelLogin(ctx, core, region, signal),
				signal,
				saveArtifact: content => ctx.sessionManager.saveArtifact(content),
			});
		},
	});
}
