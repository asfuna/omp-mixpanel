import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import type { MCPOAuthConfig } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { OAuthEndpoints } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import {
	MixpanelAuth,
	MixpanelCredentialStore,
	type MixpanelOAuthDiscovery,
	type MixpanelOAuthFlow,
} from "../src/credentials";
import { MixpanelAuthError, MixpanelNotConnectedError } from "../src/errors";
import {
	MIXPANEL_MCP_URLS,
	REGION_ENV,
	SERVICE_ACCOUNT_SECRET_ENV,
	SERVICE_ACCOUNT_USERNAME_ENV,
	type MixpanelOAuthCredential,
} from "../src/types";

const HOUR = 3_600_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<MixpanelCredentialStore> {
	const directory = await mkdtemp(path.join(tmpdir(), "omp-mixpanel-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return new MixpanelCredentialStore(path.join(directory, "omp-mixpanel", "mixpanel-auth.json"));
}

function credential(overrides: Partial<MixpanelOAuthCredential> = {}): MixpanelOAuthCredential {
	return {
		kind: "oauth",
		region: "us",
		access: "access-1",
		refresh: "refresh-1",
		expires: Date.now() + HOUR,
		clientId: "client-1",
		clientSecret: "secret-1",
		tokenUrl: "https://mixpanel.com/oauth/token/",
		authorizationUrl: "https://mixpanel.com/oauth/authorize",
		resource: MIXPANEL_MCP_URLS.us,
		...overrides,
	};
}

const endpoints: OAuthEndpoints = {
	authorizationUrl: "https://mixpanel.com/oauth/authorize",
	tokenUrl: "https://mixpanel.com/oauth/token/",
	issuerUrl: "https://mixpanel.com",
	registrationUrl: "https://mixpanel.com/oauth/mcp/register/",
	scopes: "projects analysis events insights segmentation retention data:read funnels flows data_definitions",
	resource: MIXPANEL_MCP_URLS.us,
};

function oauthFlow(overrides: {
	login?: MixpanelOAuthFlow["login"];
	refresh?: MixpanelOAuthFlow["refresh"];
} = {}): MixpanelOAuthFlow & { configs: MCPOAuthConfig[]; refreshed: MixpanelOAuthCredential[] } {
	const configs: MCPOAuthConfig[] = [];
	const refreshed: MixpanelOAuthCredential[] = [];
	return {
		configs,
		refreshed,
		async login(controller, config) {
			configs.push(config);
			if (overrides.login) return overrides.login(controller, config);
			return {
				access: "login-access",
				refresh: "login-refresh",
				expires: Date.now() + HOUR,
				clientId: "registered-client",
				clientSecret: "registered-secret",
				...(config.resource ? { resource: config.resource } : {}),
			};
		},
		async refresh(previous, signal) {
			refreshed.push(previous);
			if (overrides.refresh) return overrides.refresh(previous, signal);
			throw new Error("unexpected refresh");
		},
	};
}

function discoverWith(value: OAuthEndpoints, observed?: (url: string, resourceMetadataUrl: string) => void): MixpanelOAuthDiscovery {
	return async (serverUrl, _authServerUrl, resourceMetadataUrl) => {
		if (resourceMetadataUrl) observed?.(serverUrl, resourceMetadataUrl);
		return value;
	};
}

describe("Mixpanel credential management", () => {
	test("stores OAuth credentials with private file and directory modes", async () => {
		const store = await tempStore();
		const saved = credential();

		await store.save(saved);

		expect(await store.load()).toEqual(saved);
		expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
		expect((await stat(path.dirname(store.filePath))).mode & 0o777).toBe(0o700);
	});

	test("discovers the selected region and persists DCR and resource metadata", async () => {
		const store = await tempStore();
		let discovered: { serverUrl: string; resourceMetadataUrl: string } | undefined;
		const flow = oauthFlow({
			login: async (_controller, config) => ({
				access: "login-access",
				refresh: "login-refresh",
				expires: Date.now() + HOUR,
				clientId: "registered-client",
				clientSecret: "registered-secret",
				...(config.resource ? { resource: config.resource } : {}),
			}),
		});
		const auth = new MixpanelAuth({
			store,
			flow,
			env: { [REGION_ENV]: "in" },
			discovery: discoverWith(
				{ ...endpoints, scopes: "projects events data:read", resource: MIXPANEL_MCP_URLS.eu },
				(serverUrl, resourceMetadataUrl) => {
					discovered = { serverUrl, resourceMetadataUrl };
				},
			),
		});

		const account = await auth.login({}, "eu");
		const saved = await store.load();

		expect(discovered).toEqual({
			serverUrl: MIXPANEL_MCP_URLS.eu,
			resourceMetadataUrl: "https://mcp-eu.mixpanel.com/.well-known/oauth-protected-resource/mcp",
		});
		expect(flow.configs[0]).toMatchObject({ scopes: "projects events data:read", registrationUrl: endpoints.registrationUrl });
		expect(account).toMatchObject({ kind: "oauth", region: "eu", expires: expect.any(Number) });
		expect(saved).toMatchObject({
			region: "eu",
			access: "login-access",
			refresh: "login-refresh",
			clientId: "registered-client",
			clientSecret: "registered-secret",
			tokenUrl: endpoints.tokenUrl,
			authorizationUrl: endpoints.authorizationUrl,
			resource: MIXPANEL_MCP_URLS.eu,
		});
	});

	test("requests the advertised WWW-Authenticate scope when metadata has no scopes", async () => {
		const store = await tempStore();
		const scope = "projects analysis events insights segmentation retention data:read funnels flows data_definitions";
		const flow = oauthFlow();
		const auth = new MixpanelAuth({
			store,
			discovery: discoverWith({ ...endpoints, scopes: undefined }),
			fetch: async (_input, init) => {
				expect(init?.method).toBe("POST");
				return new Response(null, {
					status: 401,
					headers: { "www-authenticate": `Bearer scope="${scope}", resource_metadata="https://mcp.mixpanel.com/.well-known/oauth-protected-resource/mcp"` },
				});
			},
			flow,
			env: {},
		});

		await auth.login({});

		expect(flow.configs[0]?.scopes).toBe(scope);
	});

	test("refreshes tokens inside the 60-second expiry skew and persists rotation", async () => {
		const store = await tempStore();
		const now = Date.now();
		await store.save(credential({ expires: now + 30_000 }));
		const flow = oauthFlow({
			refresh: async () => ({ access: "access-2", refresh: "refresh-2", expires: now + HOUR }),
		});
		const auth = new MixpanelAuth({ store, flow, now: () => now, env: {} });

		const current = await auth.current();

		expect(current).toMatchObject({ kind: "oauth", region: "us", token: "access-2", headers: { Authorization: "Bearer access-2" } });
		expect(flow.refreshed).toHaveLength(1);
		expect(await store.load()).toMatchObject({ access: "access-2", refresh: "refresh-2", clientId: "client-1", resource: MIXPANEL_MCP_URLS.us });
	});

	test("shares one refresh between concurrent callers", async () => {
		const store = await tempStore();
		const now = Date.now();
		await store.save(credential({ expires: now - 1 }));
		const { promise: started, resolve: startRefresh } = Promise.withResolvers<void>();
		const { promise: gate, resolve: finishRefresh } = Promise.withResolvers<void>();
		const flow = oauthFlow({
			refresh: async () => {
				startRefresh();
				await gate;
				return { access: "access-2", refresh: "refresh-2", expires: now + HOUR };
			},
		});
		const auth = new MixpanelAuth({ store, flow, now: () => now, env: {} });

		const first = auth.current();
		const second = auth.current();
		await started;
		finishRefresh();
		const values = await Promise.all([first, second]);

		expect(flow.refreshed).toHaveLength(1);
		expect(values.map(value => value.token)).toEqual(["access-2", "access-2"]);
	});

	test("picks up a rotated credential from another process when refresh fails", async () => {
		const store = await tempStore();
		const now = Date.now();
		await store.save(credential({ expires: now - 1 }));
		const { promise: started, resolve: startRefresh } = Promise.withResolvers<void>();
		const { promise: gate, resolve: finishRefresh } = Promise.withResolvers<void>();
		const flow = oauthFlow({
			refresh: async () => {
				startRefresh();
				await gate;
				throw new Error("refresh token was rotated elsewhere");
			},
		});
		const auth = new MixpanelAuth({ store, flow, now: () => now, env: {} });
		const pending = auth.current();
		await started;
		await store.save(credential({ access: "access-1", refresh: "refresh-2", expires: now + HOUR }));
		finishRefresh();

		expect(await pending).toMatchObject({ token: "access-1", headers: { Authorization: "Bearer access-1" } });
		expect(flow.refreshed).toHaveLength(1);
	});

	test("rejects a refresh grant for a different data region without replacing credentials", async () => {
		const store = await tempStore();
		const now = Date.now();
		await store.save(credential({ expires: now - 1 }));
		const flow = oauthFlow({
			refresh: async (): Promise<OAuthCredentials> => ({
				access: "eu-access",
				refresh: "eu-refresh",
				expires: now + HOUR,
				region: "eu",
			}),
		});
		const auth = new MixpanelAuth({ store, flow, now: () => now, env: {} });

		const pending = auth.current();
		await expect(pending).rejects.toBeInstanceOf(MixpanelAuthError);
		await expect(pending).rejects.toThrow("token for the EU data region");
		expect(await store.load()).toMatchObject({ region: "us", access: "access-1", refresh: "refresh-1" });
	});

	test("service-account environment auth overrides saved OAuth and has no refresh path", async () => {
		const store = await tempStore();
		await store.save(credential());
		const env = {
			[SERVICE_ACCOUNT_USERNAME_ENV]: "project-user",
			[SERVICE_ACCOUNT_SECRET_ENV]: "project-secret",
			[REGION_ENV]: "in",
		};
		const flow = oauthFlow();
		const auth = new MixpanelAuth({ store, flow, env });
		const authorization = `Bearer Basic ${Buffer.from("project-user:project-secret").toString("base64")}`;

		expect(await auth.account()).toEqual({ kind: "service-account", region: "in", username: "project-user" });
		expect(await auth.current()).toMatchObject({
			kind: "service-account",
			region: "in",
			token: authorization,
			headers: { Authorization: authorization },
		});
		const rejected = auth.recover(authorization);
		await expect(rejected).rejects.toBeInstanceOf(MixpanelAuthError);
		await expect(rejected).rejects.toThrow(SERVICE_ACCOUNT_USERNAME_ENV);
		expect(flow.refreshed).toHaveLength(0);
	});

	test("missing credentials direct the user to Mixpanel login", async () => {
		const auth = new MixpanelAuth({ store: await tempStore(), env: {} });

		const pending = auth.current();
		await expect(pending).rejects.toBeInstanceOf(MixpanelNotConnectedError);
		await expect(pending).rejects.toThrow("/mixpanel login");
	});
});
