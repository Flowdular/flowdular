import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { NOTIFICATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	DELIVERY_ERROR_CLASSES,
	DELIVERY_STATUSES,
	INBOX_STATUSES,
	NOTIFICATION_KINDS,
	SUBSCRIPTION_STATUSES,
} from '../src/domain/types.ts';
import { workspaceViewHref } from '@flowdular/client/routing';
import {
	NOTIFICATIONS_UNREAD_WIDGET,
	NOTIFICATIONS_VIEWS,
	notificationsAccountMenu,
	notificationsNavigation,
} from '../src/client/navigation.ts';

const LOCALES = ['en', 'pl'];

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'notifications.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterAll(() => {
	setActiveLocale('en');
});

describe('notifications client contribution', () => {
	it('places the inbox in Workspace and the administration screens together', () => {
		expect(
			notificationsNavigation.map((entry) => [
				entry.id,
				entry.viewId,
				entry.group,
				entry.scope,
			]),
		).toEqual([
			[
				'notifications.navigation.inbox',
				'notifications-inbox',
				'Workspace',
				NOTIFICATIONS_PERMISSIONS.read,
			],
			[
				'notifications.navigation.webhooks',
				'notifications-webhooks',
				'Administration',
				NOTIFICATIONS_PERMISSIONS.webhooksRead,
			],
			[
				'notifications.navigation.deliveries',
				'notifications-deliveries',
				'Administration',
				NOTIFICATIONS_PERMISSIONS.deliveriesRead,
			],
		]);
	});

	it('reaches the personal preferences from the account menu, not the sidebar', () => {
		expect(notificationsAccountMenu).toHaveLength(1);
		const [preferences] = notificationsAccountMenu;
		expect([preferences?.id, preferences?.viewId, preferences?.scope]).toEqual([
			'notifications.account-menu.preferences',
			NOTIFICATIONS_VIEWS.preferences,
			NOTIFICATIONS_PERMISSIONS.read,
		]);
		expect(
			notificationsNavigation.some(
				(entry) => entry.viewId === NOTIFICATIONS_VIEWS.preferences,
			),
		).toBe(false);
	});

	it('puts the unread badge in the topbar behind the inbox permission', () => {
		expect(NOTIFICATIONS_UNREAD_WIDGET).toEqual({
			id: 'notifications.topbar.unread',
			slot: 'topbar.actions',
			scope: NOTIFICATIONS_PERMISSIONS.read,
			order: 10,
		});
	});

	/* The badge is rendered by the shell, outside any view, so it builds the
	   address the shell would: a bare '/notifications-inbox' misses the
	   installation path and drops the workspace out of the link. */
	describe('workspace view address', () => {
		it('keeps the installation path and the workspace the reader is in', () => {
			expect(
				workspaceViewHref(
					NOTIFICATIONS_VIEWS.inbox,
					'/app/northwind/agent-runs',
					'/app',
				),
			).toBe('/app/northwind/notifications-inbox');
			expect(
				workspaceViewHref(
					NOTIFICATIONS_VIEWS.inbox,
					'/backoffice/northwind/notifications-deliveries',
					'/backoffice',
				),
			).toBe('/backoffice/northwind/notifications-inbox');
		});

		/* One segment under the base is the view. The shell resolves a link with
		   no workspace against the open one, so this stays on the right screen. */
		it('leaves the workspace out when the address carries none', () => {
			for (const pathname of ['/app', '/app/', '/app/overview', '', '/']) {
				expect([
					pathname,
					workspaceViewHref(NOTIFICATIONS_VIEWS.inbox, pathname, '/app'),
				]).toEqual([pathname, '/app/notifications-inbox']);
			}
		});

		it('ignores an address that does not belong to the installation', () => {
			expect(
				workspaceViewHref(
					NOTIFICATIONS_VIEWS.inbox,
					'/other/northwind/overview',
					'/app',
				),
			).toBe('/app/notifications-inbox');
		});
	});

	it('targets only views the contribution registers, under unique ids', () => {
		const views = new Set<string>(Object.values(NOTIFICATIONS_VIEWS));
		const entries = [...notificationsNavigation, ...notificationsAccountMenu];
		for (const entry of entries) {
			expect([entry.id, views.has(entry.viewId)]).toEqual([entry.id, true]);
			expect(entry.scope).toMatch(/^notifications\./);
		}
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		expect(new Set(entries.map((entry) => entry.viewId)).size).toBe(
			entries.length,
		);
	});

	it('names every entry in both locales', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const entry of [
				...notificationsNavigation,
				...notificationsAccountMenu,
			]) {
				expect([locale, entry.id, entry.label.length > 0]).toEqual([
					locale,
					entry.id,
					true,
				]);
				expect([locale, entry.id, entry.description.length > 0]).toEqual([
					locale,
					entry.id,
					true,
				]);
			}
		}
	});
});

describe('notifications client copy', () => {
	it('ships the same keys in both locales', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	/* Every literal key the screens ask for. A key renamed on one side renders
	   as the raw key on screen, and nothing else would catch it. */
	it('resolves every literal key the screens ask for', () => {
		const clientDirectory = fileURLToPath(
			new URL('../src/client/', import.meta.url),
		);
		const keys = new Set<string>();
		for (const entry of readdirSync(clientDirectory)) {
			if (!entry.endsWith('.tsrx') && !entry.endsWith('.ts')) continue;
			const source = readFileSync(join(clientDirectory, entry), 'utf8');
			for (const match of source.matchAll(
				/\bt\s*\(\s*'(notifications\.[a-zA-Z0-9._-]+)'/g,
			)) {
				keys.add(match[1]!);
			}
		}
		expect(keys.size).toBeGreaterThan(80);

		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const key of keys) {
				/* A trailing dot is a prefix the screen completes at run time; the
				   closed sets below cover those. */
				if (key.endsWith('.')) continue;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
	});

	it('names every value of every closed set the screens render', () => {
		const dynamic = [
			...NOTIFICATION_KINDS.map((kind) => 'notifications.kind.' + kind),
			...NOTIFICATION_KINDS.map(
				(kind) => 'notifications.preferences.help.' + kind,
			),
			...INBOX_STATUSES.map((status) => 'notifications.status.' + status),
			...SUBSCRIPTION_STATUSES.map(
				(status) => 'notifications.subscription.status.' + status,
			),
			...DELIVERY_STATUSES.map(
				(status) => 'notifications.delivery.status.' + status,
			),
			...DELIVERY_ERROR_CLASSES.map(
				(errorClass) => 'notifications.deliveries.errorClass.' + errorClass,
			),
		];
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const key of dynamic) {
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
	});

	/* The server answers with a stable code; a code without copy would show the
	   English operator sentence instead. */
	it('translates every failure code the endpoints return', () => {
		const codes = [
			'INVALID_INPUT',
			'INBOX_ITEM_NOT_FOUND',
			'SUBSCRIPTION_NAME_CONFLICT',
			'SUBSCRIPTION_NOT_FOUND',
			'SUBSCRIPTION_STATE_INVALID',
			'SUBSCRIPTION_NOT_DISABLED',
			'WEBHOOK_URL_INVALID',
			'WEBHOOK_URL_BLOCKED',
			'WEBHOOK_HOST_NOT_ALLOWLISTED',
			'WEBHOOK_HOST_RESOLVES_PRIVATE',
			'WEBHOOK_HOST_UNRESOLVED',
			'DELIVERY_NOT_FOUND',
			'DELIVERY_NOT_DEAD_LETTER',
			'DELIVERY_REPLAY_CONFLICT',
		];
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const code of codes) {
				const key = 'notifications.error.code.' + code;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
	});
});
