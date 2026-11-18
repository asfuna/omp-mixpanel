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
