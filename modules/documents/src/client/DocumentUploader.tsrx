import { useMemo } from 'octane';
import { Alert, Button, FormField } from '@flowdular/ui';
import { t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import { DOCUMENT_LIMITS } from '../domain/types.ts';
import type { DocumentLimits } from './api.ts';
import { byteLabel, uploadRefusal } from './presentation.ts';

/* Module-local on purpose: the shared library has no FileUpload yet, and this
   screen is the first caller. Promotion candidate for @flowdular/ui once a
   second module needs the same control. */

export interface DocumentUploadValue {
	readonly file: File;
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly description: string;
}

export interface DocumentUploaderProps {
	readonly busy: boolean;
	readonly error: string;
	/** What the storage port accepts, or null while the screen is still asking. */
	readonly limits: DocumentLimits | null;
	readonly onCancel: () => void;
	readonly onSubmit: (value: DocumentUploadValue) => void;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function DocumentUploader(props: DocumentUploaderProps) @{
	const formState = useMemo(
		() => createStore({
			chosen: cell<File | null>(null),
			refusal: '',
		}),
		[],
	);
	const [chosen, setChosen] = useValue(formState.state.chosen);
	const [refusal, setRefusal] = useValue(formState.state.refusal);
	const maxObjectBytes = props.limits?.maxObjectBytes ?? null;

	const choose = (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		const refused =
			file === null ? '' : uploadRefusal(file.size, maxObjectBytes);
		formState.act((transaction) => {
			transaction.set(formState.state.refusal, refused);
			transaction.set(formState.state.chosen, refused === '' ? file : null);
		}, 'documents/upload-chosen');
	};

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!chosen) return;
		const refused = uploadRefusal(chosen.size, maxObjectBytes);
		if (refused !== '') {
			setRefusal(refused);
			return;
		}
		setRefusal('');
		const form = new FormData(event.currentTarget as HTMLFormElement);
		props.onSubmit({
			file: chosen,
			ownerModule: stringValue(form, 'ownerModule'),
			recordRef: stringValue(form, 'recordRef'),
			description: stringValue(form, 'description'),
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				<FormField
					label={t('documents.upload.form.file')}
					required
					error={refusal}
					help={chosen
						? t('documents.upload.form.chosen', {
								name: chosen.name,
								size: byteLabel(chosen.size),
							})
						: maxObjectBytes === null
							? t('documents.upload.form.fileHelp')
							: t('documents.upload.form.fileHelpLimited', {
									limit: byteLabel(maxObjectBytes),
								})}
				>
					<input
						class="ui-input"
						type="file"
						name="file"
						accept={props.limits
							? props.limits.contentTypes.join(',')
							: undefined}
						disabled={props.busy}
						autoFocus
						required
						onChange={choose}
					/>
				</FormField>
				<div class="ui-form__row">
					<FormField
						label={t('documents.upload.form.ownerModule')}
						required
						help={t('documents.upload.form.ownerModuleHelp')}
					>
						<input
							class="ui-input ui-mono"
							name="ownerModule"
							maxlength={DOCUMENT_LIMITS.ownerModule}
							placeholder={t('documents.upload.form.ownerModulePlaceholder')}
							disabled={props.busy}
							required
						/>
					</FormField>
					<FormField
						label={t('documents.upload.form.recordRef')}
						required
						help={t('documents.upload.form.recordRefHelp')}
					>
						<input
							class="ui-input ui-mono"
							name="recordRef"
							maxlength={DOCUMENT_LIMITS.recordRef}
							placeholder={t('documents.upload.form.recordRefPlaceholder')}
							disabled={props.busy}
							required
						/>
					</FormField>
				</div>
				<FormField
					label={t('documents.upload.form.description')}
					help={t('documents.upload.form.descriptionHelp')}
				>
					<textarea
						class="ui-textarea"
						name="description"
						rows={3}
						maxlength={DOCUMENT_LIMITS.description}
						disabled={props.busy}
					></textarea>
				</FormField>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('documents.upload.form.constraint')}</small>
			<div class="ui-form__actions">
				<Button type="button" onClick={props.onCancel}>{t(
					'documents.common.close',
				)}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || !chosen}
				>
					{props.busy
						? t('documents.upload.action.uploading')
						: t('documents.upload.action.submit')}
				</Button>
			</div>
		</div>
	</form>
}
