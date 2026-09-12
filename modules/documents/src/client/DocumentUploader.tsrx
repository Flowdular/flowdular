import { useMemo } from 'octane';
import { Alert, Button, FileUpload, FormField } from '@flowdular/ui';
import { t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import { DOCUMENT_LIMITS } from '../domain/types.ts';
import type { DocumentLimits } from './api.ts';
import { byteLabel, uploadRefusal } from './presentation.ts';

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

const FILE_FIELD_ID = 'documents-upload-file';

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function DocumentUploader(props: DocumentUploaderProps) @{
	const formState = useMemo(
		() => createStore({ chosen: cell<File | null>(null) }),
		[],
	);
	const [chosen, setChosen] = useValue(formState.state.chosen);
	const maxObjectBytes = props.limits?.maxObjectBytes ?? null;

	/* The control refuses a file the port would not take and hands back null, so
   a submit can only ever carry a file that passed the same check. */
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!chosen) return;
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
				<FileUpload
					id={FILE_FIELD_ID}
					name="file"
					label={t('documents.upload.form.file')}
					accept={props.limits?.contentTypes}
					maxBytes={maxObjectBytes}
					value={chosen}
					busy={props.busy}
					busyLabel={t('documents.upload.action.uploading')}
					hint={maxObjectBytes === null
						? t('documents.upload.form.fileHelp')
						: t('documents.upload.form.fileHelpLimited', {
								limit: byteLabel(maxObjectBytes),
							})}
					chosen={(file) => t('documents.upload.form.chosen', {
						name: file.name,
						size: byteLabel(file.size),
					})}
					clearLabel={t('documents.upload.form.clear')}
					refusal={(reason, file) => reason === 'size'
						? uploadRefusal(file.size, maxObjectBytes)
						: t('documents.upload.form.typeRefused')}
					required
					autoFocus
					onChange={setChosen}
				/>
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
