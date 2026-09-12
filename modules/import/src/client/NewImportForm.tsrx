import { useMemo } from 'octane';
import { Alert, Button, FormField, Switch } from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import { cell, createStore, useValue } from 'segment-state';
import { parseCsv } from '../domain/csv.ts';
import { IMPORT_MODES, type ImportMode } from '../domain/ports.ts';
import { IMPORT_MAX_CSV_BYTES } from '../domain/types.ts';
import type { ImportTargetView } from '../services/import-service.ts';
import { modeLabel } from './presentation.ts';

export interface NewImportValue {
	readonly file: File;
	readonly target: string;
	readonly mode: ImportMode;
	readonly dryRun: boolean;
	readonly columns: Readonly<Record<string, string>>;
	readonly saveMapping: boolean;
}

export interface NewImportFormProps {
	readonly targets: readonly ImportTargetView[];
	readonly busy: boolean;
	readonly error: string;
	/** The saved template for a target, offered as the starting mapping. */
	readonly loadMapping: (target: string) => Promise<
		Readonly<Record<string, string>>
	>;
	readonly onCancel: () => void;
	readonly onSubmit: (value: NewImportValue) => void;
}

/* Enough of the file to hold a header row; a header longer than this is a file
   this screen cannot offer column names for, and the reader types them. */
const HEADER_SLICE_BYTES = 64 * 1024;

async function detectHeader(file: File): Promise<readonly string[]> {
	try {
		const text = await file.slice(0, HEADER_SLICE_BYTES).text();
		/* The slice can cut a record in half, so only the header is trusted. */
		return parseCsv(text, {
			maxBytes: HEADER_SLICE_BYTES,
			maxRows: Number.MAX_SAFE_INTEGER,
		}).header;
	} catch {
		return [];
	}
}

export function NewImportForm(props: NewImportFormProps) @{
	const formState = useMemo(
		() => createStore({
			target: props.targets.find((entry) => entry.permitted)?.target ?? '',
			mode: cell<ImportMode>('create-only'),
			dryRun: true,
			saveMapping: true,
			fileName: '',
			file: cell<File | null>(null),
			header: cell<readonly string[]>([]),
			columns: cell<Readonly<Record<string, string>>>({}),
			localError: '',
		}),
		[],
	);
	const [target, setTarget] = useValue(formState.state.target);
	const [mode, setMode] = useValue(formState.state.mode);
	const [dryRun, setDryRun] = useValue(formState.state.dryRun);
	const [saveMapping, setSaveMapping] = useValue(formState.state.saveMapping);
	const [fileName, setFileName] = useValue(formState.state.fileName);
	const [file, setFile] = useValue(formState.state.file);
	const [header, setHeader] = useValue(formState.state.header);
	const [columns, setColumns] = useValue(formState.state.columns);
	const [localError, setLocalError] = useValue(formState.state.localError);

	const selected =
		props.targets.find((entry) => entry.target === target) ?? null;

	const chooseTarget = async (value: string) => {
		setTarget(value);
		setColumns(value === '' ? {} : await props.loadMapping(value));
	};

	const chooseFile = async (chosen: File | null) => {
		setLocalError('');
		setFile(chosen);
		setFileName(chosen?.name ?? '');
		if (!chosen) {
			setHeader([]);
			return;
		}
		if (chosen.size > IMPORT_MAX_CSV_BYTES) {
			setLocalError(t('import.form.error.tooLarge'));
			setHeader([]);
			return;
		}
		setHeader(await detectHeader(chosen));
	};

	const setColumn = (field: string, value: string) => {
		const next = { ...columns };
		if (value === '') delete next[field];
		else next[field] = value;
		setColumns(next);
	};

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!file || !selected) return;
		const missing = selected.fields.find(
			(field) => field.required && !columns[field.id],
		);
		if (missing) {
			setLocalError(t('import.form.error.mapping', { field: missing.label }));
			return;
		}
		setLocalError('');
		props.onSubmit({
			file,
			target: selected.target,
			mode,
			dryRun,
			columns,
			saveMapping,
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label={t('import.form.target')} required>
						<select
							class="ui-select"
							name="target"
							value={target}
							onInput={(event) => void chooseTarget(event.currentTarget.value)}
							required
						>
							<option value="">{t('import.form.targetPlaceholder')}</option>
							@for (const entry of props.targets; key entry.target) {
								<option value={entry.target} disabled={!entry.permitted}>
									{entry.permitted
										? entry.label
										: t('import.form.targetDenied', { label: entry.label })}
								</option>
							}
						</select>
					</FormField>
					<FormField label={t('import.form.mode')} required>
						<select
							class="ui-select"
							name="mode"
							value={mode}
							onInput={(event) => setMode(
								event.currentTarget.value as ImportMode,
							)}
						>
							@for (const value of IMPORT_MODES; key value) {
								<option value={value}>{modeLabel(value)}</option>
							}
						</select>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField
						label={t('import.form.file')}
						help={t('import.form.fileHelp')}
						required
					>
						<input
							class="ui-input"
							type="file"
							name="file"
							accept=".csv,text/csv"
							onChange={(event) => void chooseFile(
								event.currentTarget.files?.[0] ?? null,
							)}
							required
						/>
					</FormField>
				</div>
				@if (selected && file) {
					<div class="ui-form__section">
						<div class="ui-form__section-head">
							<b>{t('import.form.mapping')}</b>
							<small>
								{header.length > 0
									? t('import.form.mappingHelp', { file: fileName })
									: t('import.form.mappingManual')}
							</small>
						</div>
						@for (const field of selected.fields; key field.id) {
							<FormField
								label={field.label}
								help={t('import.form.fieldType', {
									type: t('import.type.' + field.type),
								})}
								required={field.required}
							>
								@if (header.length > 0) {
									<select
										class="ui-select"
										name={'column-' + field.id}
										value={columns[field.id] ?? ''}
										onInput={(event) => setColumn(
											field.id,
											event.currentTarget.value,
										)}
									>
										<option value="">{t('import.form.columnNone')}</option>
										@for (const name of header; key name) {
											<option value={name}>{name}</option>
										}
									</select>
								} @else {
									<input
										class="ui-input ui-mono"
										name={'column-' + field.id}
										value={columns[field.id] ?? ''}
										maxlength={200}
										onInput={(event) => setColumn(
											field.id,
											event.currentTarget.value,
										)}
									/>
								}
							</FormField>
						}
					</div>
				}
				<div class="ui-form__row">
					<FormField
						label={t('import.form.dryRun')}
						help={t('import.form.dryRunHelp')}
					>
						<Switch
							label={t('import.form.dryRun')}
							checked={dryRun}
							onChange={(value) => setDryRun(value)}
						/>
					</FormField>
					<FormField
						label={t('import.form.saveMapping')}
						help={t('import.form.saveMappingHelp')}
					>
						<Switch
							label={t('import.form.saveMapping')}
							checked={saveMapping}
							onChange={(value) => setSaveMapping(value)}
						/>
					</FormField>
				</div>
				@if (localError) {
					<Alert>{localError}</Alert>
				}
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('import.form.note')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('import.form.cancel')}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || !file || !selected}
				>
					{props.busy ? t('import.form.submitting') : t('import.form.submit')}
				</Button>
			</div>
		</div>
	</form>
}
