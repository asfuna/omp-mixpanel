import {
	callTool as callMCPTool,
	connectToServer,
	disconnectServer,
	listTools as listMCPTools,
} from "@oh-my-pi/pi-coding-agent/mcp";
import type {
	MCPHttpServerConfig,
	MCPServerConnection,
	MCPToolCallResult,
	MCPToolDefinition,
} from "@oh-my-pi/pi-coding-agent/mcp";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { MixpanelAuthError, MixpanelTimeoutError } from "./errors";
import type { MixpanelAuth, MixpanelAuthMaterial } from "./credentials";
import { DEFAULT_MIXPANEL_TIMEOUT_MS, MIXPANEL_MCP_URLS, type MixpanelCallOptions } from "./types";

export interface MixpanelMcpClientOptions {
	/** Override the region endpoint, primarily for tests. */
	endpoint?: string;
	/** Called when the server announces `notifications/tools/list_changed`. */
	onToolsChanged?: () => void;
}

interface MixpanelConnection {
	connection: MCPServerConnection;
	/** Token the transport currently sends. */
	token: string;
	region: MixpanelAuthMaterial["region"];
	active: number;
	retired: boolean;
	closing?: Promise<void>;
}

function isHttpAuthFailure(error: unknown): error is MCPTransportError {
	return error instanceof MCPTransportError && error.failure === "http_status" && error.code === 401;
}

function rejectedLogin(cause: unknown): MixpanelAuthError {
	return new MixpanelAuthError("Mixpanel rejected the refreshed login. Have the user run `/mixpanel login` to sign in again.", {
		cause,
	});
}

const MIXPANEL_CONNECTION_TIMEOUT_MS = 30_000;

function describeTimeout(timeoutMs: number): string {
	return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} s` : `${timeoutMs} ms`;
}

async function withDeadline<T>(
	operation: string,
	timeoutMs: number,
	callerSignal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timedOut = false;
	let callerAborted = callerSignal?.aborted ?? false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onCallerAbort = (): void => {
		if (!timedOut) callerAborted = true;
		clearTimeout(timer);
	};
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;

	if (!callerAborted) {
		callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
		timer = setTimeout(() => {
			if (callerAborted) return;
			timedOut = true;
			controller.abort();
		}, timeoutMs);
	}

	try {
		callerSignal?.throwIfAborted();
		return await run(signal);
	} catch (error) {
		if (callerAborted) throw error;
		if (timedOut) {
			throw new MixpanelTimeoutError(
				`Mixpanel ${operation} timed out after ${describeTimeout(timeoutMs)}`,
				timeoutMs,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", onCallerAbort);
	}
}

/** One lazy connection to Mixpanel's hosted MCP server; tools are not filtered by connector. */
export class MixpanelMcpClient {
	readonly #auth: MixpanelAuth;
	readonly #endpoint: string | undefined;
	readonly #onToolsChanged: (() => void) | undefined;
	#entry: Promise<MixpanelConnection> | undefined;
	#tools: Promise<MCPToolDefinition[]> | undefined;

	constructor(auth: MixpanelAuth, options: MixpanelMcpClientOptions = {}) {
		this.#auth = auth;
		this.#endpoint = options.endpoint;
		this.#onToolsChanged = options.onToolsChanged;
	}

	listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]> {
		signal?.throwIfAborted();
		if (!this.#tools) {
			const pending = this.#withConnection(signal, async entry => {
				entry.connection.tools = undefined;
				return withDeadline(
					"tools/list request",
					DEFAULT_MIXPANEL_TIMEOUT_MS,
					signal,
					deadlineSignal => listMCPTools(entry.connection, { signal: deadlineSignal }),
				);
			});
			this.#tools = pending;
			pending.catch(() => {
				if (this.#tools === pending) this.#tools = undefined;
			});
		}
		return this.#tools;
	}

	async callTool(tool: string, args: Record<string, unknown>, options?: MixpanelCallOptions): Promise<MCPToolCallResult> {
		const tools = await this.listTools(options?.signal);
		if (!tools.some(candidate => candidate.name === tool)) {
			throw new Error(`\`${tool}\` is not a Mixpanel MCP tool. Available: ${tools.map(candidate => candidate.name).join(", ") || "none"}.`);
		}
		return this.#withConnection(options?.signal, entry =>
			withDeadline(
				`request "${tool}"`,
				options?.timeoutMs ?? DEFAULT_MIXPANEL_TIMEOUT_MS,
				options?.signal,
				signal => callMCPTool(entry.connection, tool, args, { signal }),
			),
		);
	}

	/** Drop the cached tool list and connection after login/logout. */
	async reset(): Promise<void> {
		this.#tools = undefined;
		await this.closeAll();
	}

	async closeAll(): Promise<void> {
		const pending = this.#entry;
		this.#entry = undefined;
		const entry = await pending?.catch(() => undefined);
		if (entry) await this.#retire(entry);
	}

	async #withConnection<T>(signal: AbortSignal | undefined, run: (entry: MixpanelConnection) => Promise<T>): Promise<T> {
		const entry = await this.#acquire(signal);
		entry.active += 1;
		try {
			return await run(entry);
		} catch (error) {
			if (isHttpAuthFailure(error)) throw rejectedLogin(error);
			throw error;
		} finally {
			entry.active -= 1;
			if (entry.retired && entry.active === 0) void this.#close(entry);
		}
	}

	async #acquire(signal?: AbortSignal): Promise<MixpanelConnection> {
		const material = await this.#auth.current(signal);
		const pending = this.#entry;
		if (pending) {
			const entry = await pending.catch(() => undefined);
			if (entry && !entry.retired && entry.token === material.token && entry.region === material.region) return entry;
			if (this.#entry === pending) {
				this.#entry = undefined;
				if (entry) void this.#retire(entry);
			}
			if (this.#entry) return this.#acquire(signal);
		}
		const opening = this.#open(material, signal);
		this.#entry = opening;
		opening.catch(() => {
			if (this.#entry === opening) this.#entry = undefined;
		});
		return opening;
	}

	async #open(material: MixpanelAuthMaterial, signal?: AbortSignal): Promise<MixpanelConnection> {
		return withDeadline(
			"connection open",
			MIXPANEL_CONNECTION_TIMEOUT_MS,
			signal,
			async deadlineSignal => {
				let current = material;
				let connection: MCPServerConnection;
				try {
					connection = await this.#connect(current, deadlineSignal);
				} catch (error) {
					if (!isHttpAuthFailure(error)) throw error;
					current = await this.#auth.recover(current.token, deadlineSignal, current.region);
					try {
						connection = await this.#connect(current, deadlineSignal);
					} catch (retryError) {
						if (isHttpAuthFailure(retryError)) throw rejectedLogin(retryError);
						throw retryError;
					}
				}
				const entry: MixpanelConnection = {
					connection,
					token: current.token,
					region: current.region,
					active: 0,
					retired: false,
				};
				if (connection.transport instanceof HttpTransport) {
					connection.transport.onAuthError = async () => {
						const recovered = await this.#auth.recover(entry.token, undefined, entry.region);
						entry.token = recovered.token;
						return recovered.headers;
					};
				}
				return entry;
			},
		);
	}

	#connect(material: MixpanelAuthMaterial, signal?: AbortSignal): Promise<MCPServerConnection> {
		const config: MCPHttpServerConfig = {
			type: "http",
			timeout: 0,
			url: this.#endpoint ?? MIXPANEL_MCP_URLS[material.region],
			headerPolicy: "origin-locked",
			headers: material.headers,
		};
		return connectToServer("mixpanel", config, {
			...(signal ? { signal } : {}),
			onNotification: method => {
				if (method !== "notifications/tools/list_changed") return;
				this.#tools = undefined;
				this.#onToolsChanged?.();
			},
		});
	}

	#retire(entry: MixpanelConnection): Promise<void> {
		entry.retired = true;
		if (entry.active > 0) return Promise.resolve();
		return this.#close(entry);
	}

	#close(entry: MixpanelConnection): Promise<void> {
		entry.closing ??= disconnectServer(entry.connection).catch(() => {});
		return entry.closing;
	}
}
