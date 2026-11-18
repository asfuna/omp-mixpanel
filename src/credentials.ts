import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getActiveProfile, getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { MCP_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/mcp";
import {
	MCPOAuthFlow,
	refreshMCPOAuthToken,
	type MCPOAuthConfig,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import {
	discoverOAuthEndpoints,
	extractOAuthChallengeScopes,
	rfc9728ProtectedResourceMetadataUrl,
	type OAuthEndpoints,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { MixpanelAuthError, MixpanelNotConnectedError } from "./errors";
import {
	MIXPANEL_MCP_URLS,
	MIXPANEL_REGIONS,
	REGION_ENV,
	SERVICE_ACCOUNT_SECRET_ENV,
	SERVICE_ACCOUNT_USERNAME_ENV,
	type MixpanelAccount,
	type MixpanelAuthPresenter,
	type MixpanelOAuthCredential,
	type MixpanelRegion,
} from "./types";

const EXPIRY_SKEW_MS = 60_000;
const NOT_CONNECTED = "Mixpanel is not connected. Have the user run `/mixpanel login` to sign in.";

/** OAuth grant fields exposed by MCPOAuthFlow after DCR and authorization complete. */
export interface MixpanelOAuthGrant extends OAuthCredentials {
	clientId?: string;
	clientSecret?: string;
	resource?: string;
}

/** The plugin's OAuth operations; injectable so credential handling tests stay offline. */
export interface MixpanelOAuthFlow {
	login(controller: OAuthController, config: MCPOAuthConfig): Promise<MixpanelOAuthGrant>;
	refresh(credential: MixpanelOAuthCredential, signal?: AbortSignal): Promise<OAuthCredentials>;
}

export type MixpanelOAuthDiscovery = typeof discoverOAuthEndpoints;

/** OAuth material returned to the MCP client. */
export interface MixpanelAuthMaterial {
	kind: "oauth" | "service-account";
	region: MixpanelRegion;
	token: string;
	headers: Record<string, string>;
}
type MixpanelCredentialSnapshot = Pick<MixpanelOAuthCredential, "access" | "refresh" | "expires">;

/** Plugin-owned file per OMP profile: `~/.omp/agent/omp-mixpanel/mixpanel-auth[.<profile>].json`. */
export function defaultCredentialPath(profile = getActiveProfile()): string {
	const file = profile ? `mixpanel-auth.${encodeURIComponent(profile)}.json` : "mixpanel-auth.json";
	return path.join(getAgentDir(), "omp-mixpanel", file);
}

function isRegion(value: unknown): value is MixpanelRegion {
	return typeof value === "string" && MIXPANEL_REGIONS.includes(value as MixpanelRegion);
}

function isCredential(value: unknown): value is MixpanelOAuthCredential {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.kind === "oauth" &&
		isRegion(record.region) &&
		typeof record.access === "string" &&
		typeof record.refresh === "string" &&
		typeof record.expires === "number" &&
		Number.isFinite(record.expires) &&
		typeof record.clientId === "string" &&
		typeof record.tokenUrl === "string" &&
		typeof record.authorizationUrl === "string" &&
		(record.clientSecret === undefined || typeof record.clientSecret === "string") &&
		(record.resource === undefined || typeof record.resource === "string")
	);
}

/** JSON credential file with mode 0600 inside a 0700 directory, replaced atomically. */
export class MixpanelCredentialStore {
	constructor(readonly filePath: string = defaultCredentialPath()) {}

	async load(): Promise<MixpanelOAuthCredential | undefined> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new MixpanelAuthError(
				`The Mixpanel plugin login file is corrupt: ${this.filePath}. Run \`/mixpanel logout\`, then \`/mixpanel login\`.`,
			);
		}
		if (!isCredential(parsed)) {
			throw new MixpanelAuthError(
				`The Mixpanel plugin login file is invalid: ${this.filePath}. Run \`/mixpanel logout\`, then \`/mixpanel login\`.`,
			);
		}
		return parsed;
	}

	async save(credential: MixpanelOAuthCredential): Promise<void> {
		const directory = path.dirname(this.filePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.filePath);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => {});
			throw error;
		}
	}

	async clear(): Promise<void> {
		await rm(this.filePath, { force: true });
	}
}

export interface MixpanelAuthOptions {
	store?: MixpanelCredentialStore;
	flow?: MixpanelOAuthFlow;
	discovery?: MixpanelOAuthDiscovery;
	fetch?: FetchImpl;
	now?: () => number;
	/** Environment source; defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
}

function staticClientId(config: MCPOAuthConfig): string | undefined {
	const configured = config.clientId?.trim();
	if (configured) return configured;
	try {
		return new URL(config.authorizationUrl).searchParams.get("client_id")?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function credentialRegionMismatch(expected: MixpanelRegion, actual: MixpanelRegion): MixpanelAuthError {
	return new MixpanelAuthError(
		`The saved Mixpanel login changed from the ${expected.toUpperCase()} data region to ${actual.toUpperCase()} while this request was in flight. Have the user run \`/mixpanel login ${expected}\` again.`,
	);
}

function grantRegionMismatch(expected: MixpanelRegion, actual: string): MixpanelAuthError {
	return new MixpanelAuthError(
		`Mixpanel returned a token for the ${actual.toUpperCase()} data region while signing in to ${expected.toUpperCase()}. Have the user run \`/mixpanel login ${expected}\` again.`,
	);
}

function assertGrant(grant: OAuthCredentials, region: MixpanelRegion): void {
	if (grant.region && grant.region !== region) throw grantRegionMismatch(region, grant.region);
	if (!grant.access?.trim() || !grant.refresh?.trim() || !Number.isFinite(grant.expires)) {
		throw new MixpanelAuthError("Mixpanel sign-in did not return a refreshable OAuth grant. Have the user run `/mixpanel login` again.");
	}
}

function publicAccount(credential: MixpanelOAuthCredential): MixpanelAccount {
	return { kind: "oauth", region: credential.region, expires: credential.expires };
}

async function fetchChallengeScopes(fetchImpl: FetchImpl, serverUrl: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetchImpl(serverUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: "mixpanel-oauth-discovery",
				method: "initialize",
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "oh-my-pi", version: "1.0.0" },
				},
			}),
			signal,
		});
		try {
			const challenge = response.headers.get("www-authenticate");
			return challenge ? extractOAuthChallengeScopes(new Error(challenge)) : undefined;
		} finally {
			await response.body?.cancel().catch(() => {});
		}
	} catch (error) {
		signal?.throwIfAborted();
		return undefined;
	}
}

function serviceRegion(env: Readonly<Record<string, string | undefined>>): MixpanelRegion {
	const configured = env[REGION_ENV]?.trim();
	if (!configured) return "us";
	if (isRegion(configured)) return configured;
	throw new MixpanelAuthError(`\`${REGION_ENV}\` must be one of ${MIXPANEL_REGIONS.join(", ")}.`);
}

function serviceAccountRejected(): MixpanelAuthError {
	return new MixpanelAuthError(
		`Mixpanel rejected the configured service account. Check \`${SERVICE_ACCOUNT_USERNAME_ENV}\` and \`${SERVICE_ACCOUNT_SECRET_ENV}\`.`,
	);
}

/** Owns plugin OAuth credentials, service-account environment auth, and refresh recovery. */
export class MixpanelAuth {
	readonly #store: MixpanelCredentialStore;
	readonly #flow: MixpanelOAuthFlow;
	readonly #discovery: MixpanelOAuthDiscovery;
	readonly #fetch: FetchImpl;
	readonly #now: () => number;
	readonly #env: Readonly<Record<string, string | undefined>>;
	readonly #refreshing = new Map<MixpanelRegion, Promise<MixpanelOAuthCredential>>();

	constructor(options: MixpanelAuthOptions = {}) {
		this.#store = options.store ?? new MixpanelCredentialStore();
		this.#fetch = options.fetch ?? fetch;
		this.#discovery = options.discovery ?? discoverOAuthEndpoints;
		this.#flow = options.flow ?? createDefaultMixpanelOAuthFlow(this.#fetch);
		this.#now = options.now ?? Date.now;
		this.#env = options.env ?? process.env;
	}

	async account(): Promise<MixpanelAccount | undefined> {
		const serviceAccount = this.#serviceAccount();
		if (serviceAccount) {
			return { kind: "service-account", region: serviceAccount.region, username: serviceAccount.username };
		}
		const credential = await this.#store.load();
		return credential ? publicAccount(credential) : undefined;
	}

	async login(presenter: MixpanelAuthPresenter, region?: MixpanelRegion): Promise<MixpanelAccount> {
		const serviceAccount = this.#serviceAccount();
		if (serviceAccount) {
			return { kind: "service-account", region: serviceAccount.region, username: serviceAccount.username };
		}

		const selectedRegion = this.#resolveRegion(region);
		const serverUrl = MIXPANEL_MCP_URLS[selectedRegion];
		const resourceMetadataUrl = rfc9728ProtectedResourceMetadataUrl(serverUrl);
		if (!resourceMetadataUrl) {
			throw new MixpanelAuthError(`Could not discover Mixpanel OAuth endpoints for ${selectedRegion}. Have the user run \`/mixpanel login\` again.`);
		}

		let endpoints: OAuthEndpoints | null;
		try {
			endpoints = await this.#discovery(serverUrl, undefined, resourceMetadataUrl, {
				fetch: this.#fetch,
				...(presenter.signal ? { signal: presenter.signal } : {}),
			});
			presenter.signal?.throwIfAborted();
		} catch (error) {
			presenter.signal?.throwIfAborted();
			throw new MixpanelAuthError(
				`Could not discover Mixpanel OAuth endpoints for ${selectedRegion}. Have the user run \`/mixpanel login ${selectedRegion}\` again.`,
				{ cause: error },
			);
		}
		if (!endpoints?.authorizationUrl || !endpoints.tokenUrl) {
			throw new MixpanelAuthError(
				`Could not discover Mixpanel OAuth endpoints for ${selectedRegion}. Have the user run \`/mixpanel login ${selectedRegion}\` again.`,
			);
		}

		let scopes = endpoints.scopes?.trim();
		if (!scopes) scopes = (await fetchChallengeScopes(this.#fetch, serverUrl, presenter.signal))?.trim();
		const config: MCPOAuthConfig = {
			authorizationUrl: endpoints.authorizationUrl,
			tokenUrl: endpoints.tokenUrl,
			...(endpoints.issuerUrl ? { issuerUrl: endpoints.issuerUrl } : {}),
			...(endpoints.registrationUrl ? { registrationUrl: endpoints.registrationUrl } : {}),
			...(endpoints.clientId ? { clientId: endpoints.clientId } : {}),
			...(scopes ? { scopes } : {}),
			...(endpoints.resource ? { resource: endpoints.resource } : {}),
			fetch: this.#fetch,
		};
		const grant = await this.#flow.login(presenter, config);
		assertGrant(grant, selectedRegion);

		const clientId = grant.clientId?.trim() || staticClientId(config);
		if (!clientId) {
			throw new MixpanelAuthError(
				`Mixpanel sign-in did not register an OAuth client. Have the user run \`/mixpanel login ${selectedRegion}\` again.`,
			);
		}
		const clientSecret = grant.clientSecret?.trim();
		const resource = grant.resource?.trim() || endpoints.resource?.trim();
		const credential: MixpanelOAuthCredential = {
			kind: "oauth",
			region: selectedRegion,
			access: grant.access,
			refresh: grant.refresh,
			expires: grant.expires,
			clientId,
			...(clientSecret ? { clientSecret } : {}),
			tokenUrl: endpoints.tokenUrl,
			authorizationUrl: endpoints.authorizationUrl,
			...(resource ? { resource } : {}),
		};
		await this.#store.save(credential);
		return publicAccount(credential);
	}

	async logout(): Promise<void> {
		await this.#store.clear();
	}

	/** Return valid auth material, refreshing OAuth credentials inside the 60-second expiry window. */
	async current(signal?: AbortSignal): Promise<MixpanelAuthMaterial> {
		signal?.throwIfAborted();
		const serviceAccount = this.#serviceAccount();
		if (serviceAccount) return this.#serviceMaterial(serviceAccount);

		const credential = await this.#store.load();
		if (!credential) throw new MixpanelNotConnectedError(NOT_CONNECTED);
		if (this.#now() < credential.expires - EXPIRY_SKEW_MS) return this.#oauthMaterial(credential);
		return this.#oauthMaterial(await this.#refresh(credential.access, credential.region, signal, credential));
	}

	/** Refresh after a hosted MCP endpoint rejected a token, reusing a newer process's rotation when available. */
	async recover(
		rejectedToken: string,
		signal?: AbortSignal,
		expectedRegion?: MixpanelRegion,
	): Promise<MixpanelAuthMaterial> {
		signal?.throwIfAborted();
		const serviceAccount = this.#serviceAccount();
		if (serviceAccount) throw serviceAccountRejected();
		const credential = await this.#store.load();
		if (!credential) throw new MixpanelNotConnectedError(NOT_CONNECTED);
		const region = expectedRegion ?? credential.region;
		if (credential.region !== region) throw credentialRegionMismatch(region, credential.region);
		return this.#oauthMaterial(await this.#refresh(rejectedToken, region, signal, credential));
	}

	#serviceAccount(): { username: string; secret: string; region: MixpanelRegion } | undefined {
		const username = this.#env[SERVICE_ACCOUNT_USERNAME_ENV];
		const secret = this.#env[SERVICE_ACCOUNT_SECRET_ENV];
		if (!username || !secret) return undefined;
		return { username, secret, region: serviceRegion(this.#env) };
	}

	#resolveRegion(region?: MixpanelRegion): MixpanelRegion {
		if (region !== undefined) {
			if (isRegion(region)) return region;
			throw new MixpanelAuthError(`Mixpanel region must be one of ${MIXPANEL_REGIONS.join(", ")}.`);
		}
		return serviceRegion(this.#env);
	}

	#serviceMaterial(account: { username: string; secret: string; region: MixpanelRegion }): MixpanelAuthMaterial {
		const token = `Bearer Basic ${Buffer.from(`${account.username}:${account.secret}`, "utf8").toString("base64")}`;
		return { kind: "service-account", region: account.region, token, headers: { Authorization: token } };
	}

	#oauthMaterial(credential: MixpanelOAuthCredential): MixpanelAuthMaterial {
		return {
			kind: "oauth",
			region: credential.region,
			token: credential.access,
			headers: { Authorization: `Bearer ${credential.access}` },
		};
	}

	#refresh(
		staleAccess: string,
		region: MixpanelRegion,
		signal?: AbortSignal,
		snapshot?: MixpanelCredentialSnapshot,
	): Promise<MixpanelOAuthCredential> {
		const pending = this.#refreshing.get(region);
		if (pending) return pending;

		let refreshing: Promise<MixpanelOAuthCredential>;
		refreshing = this.#refreshUncached(staleAccess, region, signal, snapshot).finally(() => {
			if (this.#refreshing.get(region) === refreshing) this.#refreshing.delete(region);
		});
		this.#refreshing.set(region, refreshing);
		return refreshing;
	}

	async #refreshUncached(
		staleAccess: string,
		region: MixpanelRegion,
		signal?: AbortSignal,
		snapshot?: MixpanelCredentialSnapshot,
	): Promise<MixpanelOAuthCredential> {
		const stored = await this.#store.load();
		if (!stored) throw new MixpanelNotConnectedError(NOT_CONNECTED);
		if (stored.region !== region) throw credentialRegionMismatch(region, stored.region);
		const changedSinceSnapshot =
			snapshot !== undefined &&
			(snapshot.access !== stored.access || snapshot.refresh !== stored.refresh || snapshot.expires !== stored.expires);
		if ((changedSinceSnapshot || stored.access !== staleAccess) && this.#now() < stored.expires - EXPIRY_SKEW_MS) {
			return stored;
		}

		let grant: OAuthCredentials;
		try {
			grant = await this.#flow.refresh(stored, signal);
		} catch (error) {
			signal?.throwIfAborted();
			const latest = await this.#store.load();
			if (latest && latest.region !== region) throw credentialRegionMismatch(region, latest.region);
			if (
				latest &&
				(latest.access !== stored.access || latest.refresh !== stored.refresh || latest.expires !== stored.expires) &&
				this.#now() < latest.expires - EXPIRY_SKEW_MS
			) {
				return latest;
			}
			throw new MixpanelAuthError(
				"Could not refresh the Mixpanel login. Have the user run `/mixpanel login` to sign in again.",
				{ cause: error },
			);
		}
		assertGrant(grant, region);
		const refreshed: MixpanelOAuthCredential = {
			...stored,
			access: grant.access,
			refresh: grant.refresh,
			expires: grant.expires,
		};
		await this.#store.save(refreshed);
		return refreshed;
	}
}

/** Build the native MCP OAuth flow and refresh helper, sharing the configured fetch implementation. */
export function createDefaultMixpanelOAuthFlow(fetchImpl: FetchImpl = fetch): MixpanelOAuthFlow {
	return {
		async login(controller, config) {
			const flow = new MCPOAuthFlow(config, controller);
			const grant = await flow.login();
			return {
				...grant,
				...(flow.resolvedClientId ? { clientId: flow.resolvedClientId } : {}),
				...(flow.registeredClientSecret ? { clientSecret: flow.registeredClientSecret } : {}),
				...(flow.resource ? { resource: flow.resource } : {}),
			};
		},
		refresh(credential, signal) {
			const options = {
				fetch: fetchImpl,
				...(signal ? { signal } : {}),
				authorizationUrl: credential.authorizationUrl,
			};
			return credential.resource
				? refreshMCPOAuthToken(
						credential.tokenUrl,
						credential.refresh,
						credential.clientId,
						credential.clientSecret,
						credential.resource,
						options,
					)
				: refreshMCPOAuthToken(
						credential.tokenUrl,
						credential.refresh,
						credential.clientId,
						credential.clientSecret,
						options,
					);
		},
	};
}

export const defaultMixpanelOAuthFlow = createDefaultMixpanelOAuthFlow();
