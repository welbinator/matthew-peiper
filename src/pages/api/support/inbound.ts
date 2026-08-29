export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

/**
 * Inbound webhook from Command Center.
 * Types:
 *  - staff_message / message (default): append staff reply
 *  - ticket_update: sync status + staging_url (no message body required)
 *
 * HMAC: X-CC-Signature t=<ts>,v0=<hex> over v0:<ts>:<raw_body>
 * Secret: PUSH_NOTIFY_SECRET (same as outbound).
 */

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function hmacHex(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseSig(header: string | null): { ts: string; v0: string } | null {
	if (!header) return null;
	const parts = Object.fromEntries(
		header.split(",").map((p) => {
			const [k, ...rest] = p.trim().split("=");
			return [k, rest.join("=")];
		})
	);
	if (!parts.t || !parts.v0) return null;
	return { ts: parts.t, v0: parts.v0 };
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

export const POST: APIRoute = async ({ request }) => {
	const secret = (env as Record<string, string | undefined>).PUSH_NOTIFY_SECRET;
	if (!secret) return json({ error: "not configured" }, 503);

	const raw = await request.text();
	const sig = parseSig(request.headers.get("X-CC-Signature"));
	if (!sig) return json({ error: "missing signature" }, 403);

	const tsNum = parseInt(sig.ts, 10);
	if (!Number.isFinite(tsNum)) return json({ error: "bad timestamp" }, 403);
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - tsNum) > 60 * 10) return json({ error: "timestamp expired" }, 403);

	const expected = await hmacHex(secret, `v0:${sig.ts}:${raw}`);
	if (!timingSafeEqual(expected, sig.v0)) return json({ error: "invalid signature" }, 403);

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(raw);
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	const ticketId = String(payload.ticket_id || "").trim();
	if (!ticketId) return json({ error: "ticket_id required" }, 400);

	const db = env.DB;
	if (!db) return json({ error: "db unavailable" }, 500);

	const ticket = await db
		.prepare(`SELECT id FROM support_tickets WHERE id = ? LIMIT 1`)
		.bind(ticketId)
		.first();
	if (!ticket) return json({ error: "ticket not found" }, 404);

	const ptype = String(payload.type || "staff_message").toLowerCase();
	const status = String(payload.status || "").trim().slice(0, 40);
	const stagingUrl =
		payload.staging_url !== undefined
			? String(payload.staging_url || "").trim().slice(0, 500)
			: null;
	const updatedAt = String(payload.updated_at || payload.created_at || new Date().toISOString()).slice(
		0,
		40
	);

	// Metadata-only sync (preview ready + staging link)
	if (ptype === "ticket_update" || ptype === "status") {
		try {
			const updates: string[] = [`updated_at = ?`];
			const binds: unknown[] = [updatedAt];
			if (status) {
				updates.push(`status = ?`);
				binds.push(status);
			}
			if (stagingUrl !== null) {
				updates.push(`staging_url = ?`);
				binds.push(stagingUrl);
			}
			// If moving back out of approved via staff action, clear approved_at only when status is staging/new/etc
			if (status && status !== "approved") {
				// leave approved_at history unless explicitly cleared
			}
			binds.push(ticketId);
			await db
				.prepare(`UPDATE support_tickets SET ${updates.join(", ")} WHERE id = ?`)
				.bind(...binds)
				.run();

			// Optional staff note as message when provided
			const note = String(payload.body || "").trim().slice(0, 8000);
			const msgId = String(payload.message_id || "").trim();
			if (note) {
				const id = msgId || `msg_${Date.now().toString(36)}`;
				const author = String(payload.author_name || "Support").trim().slice(0, 120);
				await db
					.prepare(
						`INSERT OR IGNORE INTO support_messages
							(id, ticket_id, sender, author_name, body, created_at)
						 VALUES (?, ?, 'staff', ?, ?, ?)`
					)
					.bind(id, ticketId, author || "Support", note, updatedAt)
					.run();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("inbound ticket_update error:", msg);
			return json({ error: "db write failed" }, 500);
		}
		return json({ ok: true, type: "ticket_update" });
	}

	// Default: staff message
	const msgId = String(payload.message_id || "").trim();
	const body = String(payload.body || "").trim().slice(0, 8000);
	const author = String(payload.author_name || "Support").trim().slice(0, 120);
	const createdAt = String(payload.created_at || new Date().toISOString()).slice(0, 40);

	if (!body) return json({ error: "ticket_id and body required" }, 400);

	const id = msgId || `msg_${Date.now().toString(36)}`;

	try {
		await db
			.prepare(
				`INSERT OR IGNORE INTO support_messages
					(id, ticket_id, sender, author_name, body, created_at)
				 VALUES (?, ?, 'staff', ?, ?, ?)`
			)
			.bind(id, ticketId, author || "Support", body, createdAt)
			.run();

		const updates: string[] = [`updated_at = ?`];
		const binds: unknown[] = [createdAt];
		if (status) {
			updates.push(`status = ?`);
			binds.push(status);
		}
		if (stagingUrl !== null) {
			updates.push(`staging_url = ?`);
			binds.push(stagingUrl);
		}
		binds.push(ticketId);
		await db
			.prepare(`UPDATE support_tickets SET ${updates.join(", ")} WHERE id = ?`)
			.bind(...binds)
			.run();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("inbound staff message error:", msg);
		return json({ error: "db write failed" }, 500);
	}

	return json({ ok: true, id });
};
