import { env } from "cloudflare:workers";

export const SESSION_COOKIE = "mc_support_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERATIONS = 100_000;

function b64(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
	return btoa(s);
}

function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"]
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		keyMaterial,
		256
	);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
	const iterations = parseInt(parts[1], 10);
	if (!Number.isFinite(iterations) || iterations < 10_000) return false;
	const salt = fromB64(parts[2]);
	const expected = fromB64(parts[3]);
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"]
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		keyMaterial,
		expected.length * 8
	);
	const actual = new Uint8Array(bits);
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
	return diff === 0;
}

export function makeId(prefix = ""): string {
	const t = Date.now();
	const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let id = "";
	let time = t;
	for (let i = 9; i >= 0; i--) {
		id = chars[time % 32] + id;
		time = Math.floor(time / 32);
	}
	for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * 32)];
	return prefix ? `${prefix}_${id}` : id;
}

export type SupportUser = {
	id: string;
	email: string;
	name: string;
};

type SessionRecord = {
	userId: string;
	email: string;
	name: string;
	createdAt: string;
};

function sessionKey(token: string): string {
	return `support_session:${token}`;
}

export async function createSession(user: SupportUser): Promise<string> {
	const kv = env.SESSION;
	if (!kv) throw new Error("SESSION KV binding missing");
	const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
	const record: SessionRecord = {
		userId: user.id,
		email: user.email,
		name: user.name,
		createdAt: new Date().toISOString(),
	};
	await kv.put(sessionKey(token), JSON.stringify(record), {
		expirationTtl: SESSION_TTL_SECONDS,
	});
	return token;
}

export async function destroySession(token: string | null | undefined): Promise<void> {
	if (!token) return;
	const kv = env.SESSION;
	if (!kv) return;
	await kv.delete(sessionKey(token));
}

export async function getSessionUser(token: string | null | undefined): Promise<SupportUser | null> {
	if (!token) return null;
	const kv = env.SESSION;
	if (!kv) return null;
	const raw = await kv.get(sessionKey(token));
	if (!raw) return null;
	try {
		const rec = JSON.parse(raw) as SessionRecord;
		if (!rec?.userId || !rec?.email) return null;
		return { id: rec.userId, email: rec.email, name: rec.name || "" };
	} catch {
		return null;
	}
}

export function parseCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	const parts = header.split(";");
	for (const part of parts) {
		const [k, ...rest] = part.trim().split("=");
		if (k === name) return decodeURIComponent(rest.join("=") || "");
	}
	return null;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
	const parts = [
		`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_TTL_SECONDS}`,
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
	const parts = [
		`${SESSION_COOKIE}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

export function requestIsSecure(request: Request): boolean {
	const proto = request.headers.get("x-forwarded-proto") || "";
	if (proto.toLowerCase() === "https") return true;
	try {
		return new URL(request.url).protocol === "https:";
	} catch {
		return false;
	}
}

export async function requireUser(request: Request): Promise<SupportUser | null> {
	const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
	return getSessionUser(token);
}

export async function findUserByEmail(
	db: D1Database,
	email: string
): Promise<(SupportUser & { password_hash: string }) | null> {
	const row = await db
		.prepare(
			`SELECT id, email, name, password_hash FROM support_users WHERE lower(email) = lower(?) LIMIT 1`
		)
		.bind(email.trim())
		.first<{ id: string; email: string; name: string; password_hash: string }>();
	return row || null;
}
