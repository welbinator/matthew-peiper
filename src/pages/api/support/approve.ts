export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUser } from "../../../lib/support-auth";
import { notifySupportApproval } from "../../../lib/support-cc";

const SITE_ID = "master-carpenters";
const SITE_HOST = "mastercarpentersllc.com";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function newMsgId() {
	const rand = crypto.getRandomValues(new Uint8Array(8));
	return (
		"msg_" +
		[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")
	);
}

/**
 * POST /api/support/approve
 * Client approves the staging preview for their ticket.
 * Body: { ticket_id }
 */
export const POST: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: "Invalid JSON" }, 400);
	}

	const ticketId = String(body.ticket_id || body.id || "").trim();
	if (!ticketId) return json({ ok: false, error: "ticket_id required" }, 400);

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	try {
		const ticket = await db
			.prepare(
				`SELECT id, subject, user_id, status, staging_url, approved_at
				 FROM support_tickets WHERE id = ? LIMIT 1`
			)
			.bind(ticketId)
			.first<{
				id: string;
				subject: string;
				user_id: string;
				status: string;
				staging_url: string;
				approved_at: string;
			}>();

		if (!ticket || ticket.user_id !== user.id) {
			return json({ ok: false, error: "Not found" }, 404);
		}

		const st = String(ticket.status || "");
		if (st === "approved" || ticket.approved_at) {
			return json({
				ok: true,
				already: true,
				ticket: {
					id: ticket.id,
					status: "approved",
					staging_url: ticket.staging_url || "",
					approved_at: ticket.approved_at || "",
				},
			});
		}
		if (st === "done" || st === "closed") {
			return json({ ok: false, error: "This request is already closed." }, 400);
		}
		if (st !== "staging") {
			return json(
				{
					ok: false,
					error:
						"A preview isn’t ready to approve yet. Wait until status is “Preview ready.”",
				},
				400
			);
		}

		const now = new Date().toISOString();
		const msgId = newMsgId();
		const staging = (ticket.staging_url || "").trim();
		const bodyText = staging
			? `I reviewed the preview and approve these changes.\n\nPreview: ${staging}`
			: "I reviewed the preview and approve these changes.";

		await db.batch([
			db
				.prepare(
					`UPDATE support_tickets
					 SET status = 'approved', approved_at = ?, updated_at = ?
					 WHERE id = ? AND user_id = ?`
				)
				.bind(now, now, ticketId, user.id),
			db
				.prepare(
					`INSERT INTO support_messages
						(id, ticket_id, sender, author_name, body, created_at)
					 VALUES (?, ?, 'client', ?, ?, ?)`
				)
				.bind(msgId, ticketId, user.name || user.email, bodyText, now),
		]);

		try {
			await notifySupportApproval({
				ticket_id: ticketId,
				message_id: msgId,
				site_id: SITE_ID,
				site: SITE_HOST,
				subject: ticket.subject,
				body: bodyText,
				staging_url: staging,
				user_email: user.email,
				user_name: user.name || "",
				created_at: now,
				approved_at: now,
			});
		} catch (err) {
			console.warn("support approval CC notify error:", err);
		}

		return json({
			ok: true,
			ticket: {
				id: ticketId,
				status: "approved",
				staging_url: staging,
				approved_at: now,
			},
			message: { id: msgId, body: bodyText, created_at: now },
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support approve error:", msg);
		return json({ ok: false, error: "Could not approve" }, 500);
	}
};
