export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUser } from "../../../lib/support-auth";
import { notifySupportDisapproval } from "../../../lib/support-cc";

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
 * POST /api/support/disapprove
 * Client rejects the staging preview and explains why.
 * Body: { ticket_id, reason }
 * Sets status to changes_requested, keeps staging_url for reference.
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
	const reason = String(body.reason || body.body || body.message || "")
		.trim()
		.slice(0, 8000);
	if (!ticketId) return json({ ok: false, error: "ticket_id required" }, 400);
	if (!reason || reason.length < 3) {
		return json(
			{ ok: false, error: "Please explain what you didn’t like (a short note is fine)." },
			400
		);
	}

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
		if (st === "done" || st === "closed") {
			return json({ ok: false, error: "This request is already closed." }, 400);
		}
		if (st === "approved") {
			return json(
				{
					ok: false,
					error:
						"You already approved this preview. Reply in the thread if you need a new change.",
				},
				400
			);
		}
		if (st !== "staging") {
			return json(
				{
					ok: false,
					error:
						"A preview isn’t ready to review yet. Wait until status is “Preview ready.”",
				},
				400
			);
		}

		const now = new Date().toISOString();
		const msgId = newMsgId();
		const staging = (ticket.staging_url || "").trim();
		const bodyText = staging
			? `I reviewed the preview and need changes before going live.\n\nWhat I didn’t like / what to fix:\n${reason}\n\nPreview: ${staging}`
			: `I reviewed the preview and need changes before going live.\n\nWhat I didn’t like / what to fix:\n${reason}`;

		await db.batch([
			db
				.prepare(
					`UPDATE support_tickets
					 SET status = 'changes_requested',
					     approved_at = '',
					     updated_at = ?
					 WHERE id = ? AND user_id = ?`
				)
				.bind(now, ticketId, user.id),
			db
				.prepare(
					`INSERT INTO support_messages
						(id, ticket_id, sender, author_name, body, created_at)
					 VALUES (?, ?, 'client', ?, ?, ?)`
				)
				.bind(msgId, ticketId, user.name || user.email, bodyText, now),
		]);

		try {
			await notifySupportDisapproval({
				ticket_id: ticketId,
				message_id: msgId,
				site_id: SITE_ID,
				site: SITE_HOST,
				subject: ticket.subject,
				body: bodyText,
				reason,
				staging_url: staging,
				user_email: user.email,
				user_name: user.name || "",
				created_at: now,
			});
		} catch (err) {
			console.warn("support disapproval CC notify error:", err);
		}

		return json({
			ok: true,
			ticket: {
				id: ticketId,
				status: "changes_requested",
				staging_url: staging,
				approved_at: "",
			},
			message: { id: msgId, body: bodyText, created_at: now },
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support disapprove error:", msg);
		return json({ ok: false, error: "Could not submit feedback" }, 500);
	}
};
