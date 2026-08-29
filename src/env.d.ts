/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type Env = {
	DB: D1Database;
	SESSION: KVNamespace;
	PUSH_NOTIFY_SECRET?: string;
	CC_NOTIFY_URL?: string;
	CC_SUPPORT_URL?: string;
};

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
	interface Locals extends Runtime {}
}
