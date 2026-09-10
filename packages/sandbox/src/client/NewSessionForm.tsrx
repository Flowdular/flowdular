import { useEffect, useRef, useState } from 'octane';
import { Button, Icon } from '@flowdular/ui';
import type { DriverSummary } from './api.ts';
import {
	ATTACH_ACCEPT,
	attachmentKind,
	attachmentRefusal,
	formatBytes,
} from './attachments.ts';
import { useTranslation } from './i18n.ts';

export interface NewSessionFormProps {
	readonly drivers: readonly DriverSummary[];
	readonly driver: string;
	readonly busy: boolean;
	readonly onDriver: (driver: string) => void;
	readonly onCreate: (brief: string, driver: string, attachments: readonly File[]) => void;
}
/* A file the operator attached before the session exists. It is uploaded to
   the new session id right after the session is created. */
interface PickedFile {
	readonly key: string;
	readonly file: File;
	readonly kind: 'image' | 'file';
	/* Object URL for an image thumbnail, empty otherwise. Revoked on removal
   and when the screen goes away. */
	readonly url: string;
}

export function NewSessionForm(props: NewSessionFormProps) @{
	const { t } = useTranslation();
	const offered = props.drivers.filter((driver) => driver.offered);
	const selected =
		offered.find((driver) => driver.id === props.driver) ?? offered[0] ?? null;
	const attachInput = useRef<HTMLInputElement | null>(null);
	const opened = useRef<string[]>([]);
	const [picked, setPicked] = useState<readonly PickedFile[]>([]);
	const [attachError, setAttachError] = useState('');

	/* Thumbnails hold object URLs; nothing else releases them, so the screen
   does it when it goes away. */
	useEffect(
		() => () => {
			for (const url of opened.current) URL.revokeObjectURL(url);
		},
		[],
	);

	const addFiles = (chosen: readonly File[]) => {
		const next = [...picked];
		let refusal = '';
		for (const file of chosen) {
			const reason = attachmentRefusal(file, next.length);
			if (reason) {
				refusal = reason;
				continue;
			}
			const kind = attachmentKind(file);
			const url =
				kind === 'image' ? URL.createObjectURL(file) : '';
			if (url) opened.current.push(url);
			next.push({
				key: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(
					2,
					8,
				)}`,
				file,
				kind,
				url,
			});
		}
		setPicked(next);
		setAttachError(refusal);
	};

	const removeFile = (key: string) => {
		const found = picked.find((item) => item.key === key);
		if (found?.url) URL.revokeObjectURL(found.url);
		setPicked(picked.filter((item) => item.key !== key));
	};

	const onPaste = (event: ClipboardEvent) => {
		const files = event.clipboardData?.files;
		if (!files || files.length === 0) return;
		const images = Array.from(files).filter(
			(file) => file.type.startsWith('image/'),
		);
		if (images.length === 0) return;
		event.preventDefault();
		addFiles(images);
	};

	const onPick = (event: Event & { currentTarget: HTMLInputElement }) => {
		const chosen = event.currentTarget.files;
		if (chosen && chosen.length > 0) addFiles(Array.from(chosen));
		event.currentTarget.value = '';
	};

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const brief = form.get('brief');
		if (typeof brief === 'string' && brief.trim().length > 7 && selected) {
			props.onCreate(
				brief.trim(),
				selected.id,
				picked.map((item) => item.file),
			);
		}
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (picked.length > 0 || attachError) {
					<div class="chat__attachments">
						@for (const item of picked; key item.key) {
							<div class="chat__attachment">
								@if (item.kind === 'image') {
									<img
										class="chat__attachment-thumb"
										src={item.url}
										alt={item.file.name}
									/>
								} @else {
									<span
										class="chat__attachment-thumb chat__attachment-thumb--file"
									>
										<Icon name="file-text" size={18} />
									</span>
								}
								<span class="chat__attachment-info">
									<span class="chat__attachment-name">{item.file.name}</span>
									<span class="chat__attachment-size">{formatBytes(
										item.file.size,
									)}</span>
								</span>
								<button
									class="chat__attachment-remove"
									type="button"
									aria-label={t('sandbox.attachments.remove', {
										name: item.file.name,
									})}
									onClick={() => removeFile(item.key)}
								>
									<Icon name="x" size={12} />
								</button>
							</div>
						}
						@if (attachError) {
							<span class="chat__attachment-error">{attachError}</span>
						}
					</div>
				}
				<textarea
					class="ui-textarea"
					aria-label={t('sandbox.sessions.brief.placeholder')}
					minlength={8}
					maxlength={20000}
					name="brief"
					rows={4}
					placeholder={t('sandbox.sessions.brief.placeholder')}
					required
					onPaste={onPaste}
				></textarea>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<button
				class="chat__attach"
				type="button"
				aria-label={t('sandbox.attachments.action')}
				title={t('sandbox.attachments.help')}
				onClick={() => attachInput.current?.click()}
			>
				<Icon name="plus" size={16} />
			</button>
			<input
				ref={attachInput}
				class="chat__attach-input"
				type="file"
				multiple
				accept={ATTACH_ACCEPT}
				onChange={onPick}
			/>
			<select
				class="chat__picker"
				aria-label={t('sandbox.sessions.driver.label')}
				value={selected?.id ?? ''}
				disabled={offered.length === 0}
				onChange={(event) => props.onDriver(event.currentTarget.value)}
			>
				@for (const driver of offered; key driver.id) {
					<option value={driver.id}>{driver.label}</option>
				}
			</select>
			<span class="sandbox__spacer"></span>
			<Button
				size="sm"
				variant="primary"
				type="submit"
				disabled={props.busy || offered.length === 0}
			>
				<Icon name="play" size={14} />
				{props.busy
					? t('sandbox.sessions.planning')
					: t('sandbox.sessions.start')}
			</Button>
		</div>
		<p class="ui-note">
			{selected ? selected.description : t('sandbox.sessions.driver.none')}
		</p>
	</form>
}
