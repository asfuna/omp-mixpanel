import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMixpanelCore, findMixpanelTool } from "../src/core";
import { MixpanelCredentialStore, type MixpanelOAuthFlow } from "../src/credentials";
import { MixpanelAuthError, MixpanelTimeoutError } from "../src/errors";
import {
	MIXPANEL_MCP_URLS,
	REGION_ENV,
	SERVICE_ACCOUNT_SECRET_ENV,
	SERVICE_ACCOUNT_USERNAME_ENV,
	type MixpanelOAuthCredential,
} from "../src/types";
import { createFakeMixpanel, FAKE_MIXPANEL_TOOLS, type FakeMixpanel, type FakeMixpanelOptions } from "./fixtures/fake-mcp";

const HOUR = 3_600_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<MixpanelCredentialStore> {
	const directory = await mkdtemp(path.join(tmpdir(), "omp-mixpanel-client-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return new MixpanelCredentialStore(path.join(directory, "omp-mixpanel", "mixpanel-auth.json"));
}

function fakeServer(options: FakeMixpanelOptions = {}): FakeMixpanel {
	const server = createFakeMixpanel(options);
	cleanups.push(() => server.stop());
	return server;
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

function oauthFlow(refresh: MixpanelOAuthFlow["refresh"] = async () => {
	throw new Error("unexpected refresh");
}): MixpanelOAuthFlow & { refreshed: MixpanelOAuthCredential[] } {
	const refreshed: MixpanelOAuthCredential[] = [];
	return {
		refreshed,
		async login() {
			throw new Error("interactive OAuth login must not run");
		},
		async refresh(previous, signal) {
			refreshed.push(previous);
			return refresh(previous, signal);
		},
	};
}

describe("Mixpanel hosted MCP client", () => {
	test("lists every Mixpanel tool, calls by exact name, and refuses unknown names", async () => {
		const fake = fakeServer();
		const store = await tempStore();
		await store.save(credential());
		const core = createMixpanelCore({ auth: { store, flow: oauthFlow(), env: {} }, client: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		const tools = await core.listTools();
		const result = await core.callTool("Get-Projects", { project_id: "p1" });
		await expect(core.callTool("get-projects", {})).rejects.toThrow("not a Mixpanel MCP tool");

		expect(tools.map(tool => tool.name)).toEqual(FAKE_MIXPANEL_TOOLS.map(tool => tool.name));
		expect(result.structuredContent).toEqual({ ok: true });
		expect(fake.requests.filter(request => request.method === "tools/call")).toHaveLength(1);
		expect(fake.requests.find(request => request.method === "tools/call")).toMatchObject({
			authorization: "Bearer access-1",
			tool: "Get-Projects",
		});
	});

	test("times out a tool call and leaves the connection usable", async () => {
		const { promise: received, resolve: requestReceived } = Promise.withResolvers<void>();
		let callCount = 0;
		const fake = fakeServer({
			delayMs: () => {
				if (callCount++ === 0) {
					requestReceived();
					return 1_000;
				}
				return 0;
			},
		});
		const store = await tempStore();
		await store.save(credential());
		const core = createMixpanelCore({ auth: { store, flow: oauthFlow(), env: {} }, client: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.listTools();
		const pending = core.callTool("Run-Query", {}, { timeoutMs: 250 }).catch(error => error);
		const receivedBeforeTimeout = await Promise.race([received.then(() => true), pending.then(() => false)]);
		expect(receivedBeforeTimeout).toBe(true);
		const timeout = await pending;

		expect(timeout).toBeInstanceOf(MixpanelTimeoutError);
		expect(timeout).toMatchObject({ timeoutMs: 250, cause: expect.anything() });
		const result = await core.callTool("Get-Projects", {});
		expect(result.structuredContent).toEqual({ ok: true });
		expect(fake.requests.filter(request => request.method === "tools/call")).toHaveLength(2);
		expect(fake.requests.filter(request => request.method === "initialize")).toHaveLength(1);
	});

	test("preserves a caller abort instead of reporting a Mixpanel timeout", async () => {
		const { promise: received, resolve: requestReceived } = Promise.withResolvers<void>();
		const fake = fakeServer({
			delayMs: () => {
				requestReceived();
				return 500;
			},
		});
		const store = await tempStore();
		await store.save(credential());
		const core = createMixpanelCore({ auth: { store, flow: oauthFlow(), env: {} }, client: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.listTools();
		const controller = new AbortController();
		const pending = core.callTool("Run-Query", {}, { signal: controller.signal, timeoutMs: 2_000 }).catch(error => error);
		await received;
		controller.abort();
		const aborted = await pending;

		expect(aborted).toBe(controller.signal.reason);
		expect(aborted).toHaveProperty("name", "AbortError");
		expect(aborted).not.toBeInstanceOf(MixpanelTimeoutError);
	});

	test("refreshes an OAuth token after HTTP 401 and retries the MCP operation", async () => {
		const rejected = new Set<string>();
		const fake = fakeServer({ rejectedTokens: rejected });
		const store = await tempStore();
		await store.save(credential());
		const flow = oauthFlow(async () => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR }));
		const core = createMixpanelCore({ auth: { store, flow, env: {} }, client: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.listTools();
		rejected.add("access-1");
		const result = await core.callTool("Get-Projects", {});

		expect(result.isError).toBeFalsy();
		expect(flow.refreshed).toHaveLength(1);
		expect(fake.requests.filter(request => request.method === "tools/call").map(request => request.authorization)).toEqual([
			"Bearer access-1",
			"Bearer access-2",
		]);
		expect(await store.load()).toMatchObject({ access: "access-2", refresh: "refresh-2", clientId: "client-1" });
	});

	test("refreshes an almost-expired OAuth credential before connecting", async () => {
		const fake = fakeServer({ rejectedTokens: new Set(["access-1"]) });
		const store = await tempStore();
		await store.save(credential({ expires: Date.now() + 10_000 }));
		const flow = oauthFlow(async () => ({ access: "access-2", refresh: "refresh-2", expires: Date.now() + HOUR }));
		const core = createMixpanelCore({ auth: { store, flow, env: {} }, client: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.listTools();

		expect(flow.refreshed).toHaveLength(1);
		expect(fake.requests.length).toBeGreaterThan(0);
		expect(fake.requests.every(request => request.authorization === "Bearer access-2")).toBe(true);
		expect(await store.load()).toMatchObject({ access: "access-2", refresh: "refresh-2" });
	});

	test("sends the service-account Basic bearer header and honors MIXPANEL_REGION", async () => {
		const fake = fakeServer();
		const store = await tempStore();
		const username = "project-user";
		const secret = "project-secret";
		const authorization = `Bearer Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
		const env = {
			[SERVICE_ACCOUNT_USERNAME_ENV]: username,
			[SERVICE_ACCOUNT_SECRET_ENV]: secret,
			[REGION_ENV]: "eu",
		};
		const core = createMixpanelCore({ auth: { store, env }, client: { endpoint: fake.endpoint } });
		cleanups.push(() => core.closeAll());

		await core.listTools();

		expect(await core.account()).toEqual({ kind: "service-account", region: "eu", username });
		expect(fake.requests.every(request => request.authorization === authorization)).toBe(true);
	});

	test("does not refresh a rejected service account and reports which variables to check", async () => {
		const username = "project-user";
		const secret = "project-secret";
		const token = `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
		const fake = fakeServer({ rejectedTokens: new Set([token]) });
		const store = await tempStore();
		const flow = oauthFlow();
		const core = createMixpanelCore({
			auth: {
				store,
				flow,
				env: { [SERVICE_ACCOUNT_USERNAME_ENV]: username, [SERVICE_ACCOUNT_SECRET_ENV]: secret },
			},
			client: { endpoint: fake.endpoint },
		});
		cleanups.push(() => core.closeAll());

		const rejected = core.listTools();
		await expect(rejected).rejects.toBeInstanceOf(MixpanelAuthError);
		await expect(rejected).rejects.toThrow(SERVICE_ACCOUNT_SECRET_ENV);
		expect(flow.refreshed).toHaveLength(0);
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.authorization).toBe(`Bearer ${token}`);
	});

	test("matches exact tool names before case-insensitive matches", () => {
		const tools = [{ name: "Get-Projects" }, { name: "get-projects" }];
		expect(findMixpanelTool(tools, "Get-Projects")).toBe(tools[0]);
		expect(findMixpanelTool(tools, "GET-PROJECTS")).toBe(tools[0]);
	});
});
