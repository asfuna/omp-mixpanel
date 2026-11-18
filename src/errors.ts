export class MixpanelNotConnectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MixpanelNotConnectedError";
	}
}

export class MixpanelAuthError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MixpanelAuthError";
	}
}

/** A Mixpanel request exceeded the plugin's own deadline (not a caller abort). */
export class MixpanelTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(message: string, timeoutMs: number, options?: ErrorOptions) {
		super(message, options);
		this.name = "MixpanelTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}
