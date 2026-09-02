import { activeLocale, t } from './i18n.ts';

/* The composer's mirror of the limits server/attachments.ts enforces. The
   server stays the authority; refusing here only saves an upload that would be
   rejected, and the two lists must move together. */
export const ATTACHMENT_EXTENSIONS = [
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'md',
	'txt',
	'json',
	'csv',
	'pdf',
	'svg',
];

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ATTACH_ACCEPT =
	'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg,.md,.txt,.json,.csv,.pdf';

export function formatBytes(size: number): string {
	const value =
		size < 1024
			? size
			: size < 1024 * 1024
				? size / 1024
				: size / (1024 * 1024);
	const count = new Intl.NumberFormat(activeLocale(), {
		maximumFractionDigits: size < 1024 * 1024 ? 0 : 1,
	}).format(value);
	return size < 1024
		? t('sandbox.attachments.bytes', { count })
		: size < 1024 * 1024
			? t('sandbox.attachments.kilobytes', { count })
			: t('sandbox.attachments.megabytes', { count });
}

export function attachmentKind(file: File): 'image' | 'file' {
	return file.type.startsWith('image/') && file.type !== 'image/svg+xml'
		? 'image'
		: 'file';
}

/* Why this file cannot be attached, or null when it can. `held` is how many the
   composer already holds. */
export function attachmentRefusal(file: File, held: number): string | null {
	if (held >= MAX_ATTACHMENTS) {
		return t('sandbox.attachments.limit', { count: MAX_ATTACHMENTS });
	}
	const dot = file.name.lastIndexOf('.');
	const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
	if (!ATTACHMENT_EXTENSIONS.includes(extension)) {
		return t('sandbox.attachments.type', {
			name: file.name,
			types: ATTACHMENT_EXTENSIONS.join(', '),
		});
	}
	if (file.size === 0) {
		return t('sandbox.attachments.empty', { name: file.name });
	}
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return t('sandbox.attachments.tooLarge', {
			name: file.name,
			size: MAX_ATTACHMENT_BYTES / (1024 * 1024),
		});
	}
	return null;
}
