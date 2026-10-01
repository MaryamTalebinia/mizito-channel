export class MizitoError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends MizitoError {
  constructor(message: string) {
    super(message, "AUTH");
  }
}

export class RateLimited extends MizitoError {
  constructor() {
    super("Mizito rate-limited the request; slow down and retry", "RATE_LIMITED");
  }
}

export class NetworkError extends MizitoError {
  constructor(message: string) {
    super(message, "NETWORK");
  }
}

export class SchemaError extends MizitoError {
  constructor(readonly endpoint: string, detail: string) {
    super(`Unexpected response from ${endpoint}: ${detail}`, "SCHEMA");
  }
}

export class SendDisabled extends MizitoError {
  constructor() {
    super("Sending is disabled. Set MIZITO_ALLOW_SEND=1 to enable it.", "SEND_DISABLED");
  }
}

export class ChatNotFound extends MizitoError {
  constructor(readonly query: string) {
    super(`No chat matches "${query}"`, "CHAT_NOT_FOUND");
  }
}

export class AmbiguousChat extends MizitoError {
  constructor(readonly query: string, readonly candidates: string[]) {
    super(`"${query}" matches several chats: ${candidates.join(", ")}`, "AMBIGUOUS_CHAT");
  }
}

export class ConfigError extends MizitoError {
  constructor(message: string) {
    super(message, "CONFIG");
  }
}
