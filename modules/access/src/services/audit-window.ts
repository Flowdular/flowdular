import {
	ACCESS_LIMITS,
	type AccessChange,
	type AccessChangePage,
	type AccessWindow,
	type AuditPosition,
} from '../domain/types.ts';
import {
	changeCategory,
	changeDetail,
	type AccessReportKind,
} from './changes.ts';
import type { AccessDirectory, DirectoryAuditEvent } from './directory.ts';

export interface WindowRequest {
	readonly window: AccessWindow;
	readonly kind: AccessReportKind;
	readonly limit: number;
	/** Where the previous request stopped scanning, not what it last showed. */
	readonly after: AuditPosition | null;
}

function change(
	event: DirectoryAuditEvent,
	category: AccessChange['category'],
): AccessChange {
	return {
		id: event.id,
		occurredAt: event.occurredAt,
		category,
		action: event.action,
		actor: event.actorLabel,
		actorAccountId: event.actorAccountId,
		actorKind: event.actorKind,
		subjectType: event.subjectType,
		subjectId: event.subjectId,
		detail: changeDetail(event.metadata),
	};
}

/**
 * The bounded walk both reports run on. The window is the read's own predicate,
 * so every event a page answers is inside it and the walk only has to bound
 * itself: one call reads at most `ACCESS_LIMITS.auditPages` pages of the trail
 * and answers the position it stopped scanning at, so a workspace with a long
 * trail is paged rather than walked whole, and a page that matched nothing still
 * moves the reader on. `next` is null once the window is exhausted, which is how
 * a client knows to stop rather than by counting rows.
 */
export async function walkAuditWindow(
	directory: AccessDirectory,
	tenantId: string,
	request: WindowRequest,
): Promise<AccessChangePage> {
	const items: AccessChange[] = [];
	let position = request.after;
	for (let page = 0; page < ACCESS_LIMITS.auditPages; page += 1) {
		const events = await directory.auditPage(
			tenantId,
			request.window,
			position,
			ACCESS_LIMITS.auditPage,
		);
		for (const event of events) {
			position = { occurredAt: event.occurredAt, id: event.id };
			const category = changeCategory(event.action, request.kind);
			if (category === null) continue;
			items.push(change(event, category));
			if (items.length === request.limit) {
				return { items, window: request.window, next: position };
			}
		}
		if (events.length < ACCESS_LIMITS.auditPage) {
			return { items, window: request.window, next: null };
		}
	}
	return { items, window: request.window, next: position };
}
