/**
 * Shared contract between the core (Mixpanel auth + hosted MCP client) and the surfaces
 * (`xd://mixpanel` device and the /mixpanel command).
 */
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import type { MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";

export const MIXPANEL_REGIONS = ["us", "eu", "in"] as const;
export type MixpanelRegion = (typeof MIXPANEL_REGIONS)[number];

/** Mixpanel's hosted MCP server per data region (https://docs.mixpanel.com/docs/mcp). */
export const MIXPANEL_MCP_URLS: Record<MixpanelRegion, string> = {
	us: "https://mcp.mixpanel.com/mcp",
	eu: "https://mcp-eu.mixpanel.com/mcp",
	in: "https://mcp-in.mixpanel.com/mcp",
};

/** Service-account env vars; when both are set they win over the stored OAuth login. */
export const SERVICE_ACCOUNT_USERNAME_ENV = "MIXPANEL_SERVICE_ACCOUNT_USERNAME";
export const SERVICE_ACCOUNT_SECRET_ENV = "MIXPANEL_SERVICE_ACCOUNT_SECRET";
/** Region for the service account (and default for `/mixpanel login`); `us` when unset. */
export const REGION_ENV = "MIXPANEL_REGION";

/** The plugin's own Mixpanel OAuth login (dynamic client registration + PKCE); never shared with OMP's `/mcp` logins. */
export interface MixpanelOAuthCredential {
	kind: "oauth";
	region: MixpanelRegion;
	access: string;
	refresh: string;
	/** Epoch ms. */
	expires: number;
	/** Client registered via DCR at login; reused for refresh. */
	clientId: string;
	clientSecret?: string;
	tokenUrl: string;
	authorizationUrl: string;
	resource?: string;
}

/** Non-secret view of the active login. */
export interface MixpanelAccount {
	kind: "oauth" | "service-account";
	region: MixpanelRegion;
	/** Service-account username; absent for OAuth. */
	username?: string;
	/** OAuth access-token expiry, epoch ms. */
	expires?: number;
}

/** OAuth presentation for the Mixpanel sign-in, as OMP's own `/login` drives it. */
export type MixpanelAuthPresenter = Pick<OAuthController, "onAuth" | "onProgress" | "onManualCodeInput" | "signal">;

/** Default per-request deadline for Mixpanel MCP calls; queries routinely exceed 30 s. */
export const DEFAULT_MIXPANEL_TIMEOUT_MS = 120_000;

export interface MixpanelCallOptions {
	signal?: AbortSignal;
	/** Per-request deadline; defaults to DEFAULT_MIXPANEL_TIMEOUT_MS. Expiry throws MixpanelTimeoutError. */
	timeoutMs?: number;
}

export interface MixpanelCore {
	/** Active login (service-account env first, then stored OAuth) without touching the network. */
	account(): Promise<MixpanelAccount | undefined>;
	/** Interactive Mixpanel OAuth sign-in for `region`; replaces any previous plugin login. */
	login(presenter: MixpanelAuthPresenter, region?: MixpanelRegion): Promise<MixpanelAccount>;
	/** Forget the stored OAuth login and close connections (service-account env is untouched). */
	logout(): Promise<void>;
	/** Tools of the Mixpanel MCP server, memoized until login/logout or tools/list_changed. */
	listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]>;
	/** Call one Mixpanel MCP tool by its exact server name; unknown names are refused. */
	callTool(tool: string, args: Record<string, unknown>, options?: MixpanelCallOptions): Promise<MCPToolCallResult>;
	/** Close the live MCP connection (session_shutdown). */
	closeAll(): Promise<void>;
}
