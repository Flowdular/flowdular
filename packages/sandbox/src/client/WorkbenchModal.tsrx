import { useEffect, useState } from 'octane';
import { Button, Icon } from '@coreloom/ui';
import type { SandboxSession } from '../server/sessions.ts';
import { loadModuleSpec, saveModuleSpec } from './api.ts';
import { DiffPane, type ModuleDiff } from './DiffPane.tsrx';
import { useTranslation } from './i18n.ts';

export type WorkbenchMode = 'preview' | 'diff' | 'spec';

export interface WorkbenchModalProps {
	readonly mode: WorkbenchMode;
	readonly session: SandboxSession;
	readonly diffs: readonly ModuleDiff[];
	readonly nonce: number;
	readonly selecting: boolean;
	/* The module the preview opens on and the diff is filtered to; empty means
   every module of the session. */
	readonly activeModule: string;
	/* The module whose specification the spec mode edits. */
	readonly specModule: string;
	readonly previewData: 'fixtures' | 'bridge';
	readonly onModule: (directory: string) => void;
	readonly onMode: (mode: WorkbenchMode) => void;
	readonly onToggleSelect: () => void;
	readonly onReload: () => void;
	readonly onPreviewData: (mode: 'fixtures' | 'bridge') => void;
	readonly onAskAbout: (path: string) => void;
	/* The specification on disk changed, so the session view is stale. */
	readonly onSpecSaved: () => void;
	readonly onClose: () => void;
}

/* Full screen is where the module is actually worked on: the preview is
   interactive here, and the diff finally has the width it needs. */
export function WorkbenchModal(props: WorkbenchModalProps) @{
	const { t } = useTranslation();
	const source =
		'/preview/' + props.session.id + '?n=' + props.nonce +
			(props.selecting ? '&select=1' : '') +
		(props.activeModule ? '&module=' + props.activeModule : '');
	const shown =
		props.activeModule
			? props.diffs.filter((diff) => diff.module === props.activeModule)
			: props.diffs;
	const specModule =
		props.specModule || props.activeModule ||
			props.session.modules[0]!.directory;
	const sessionId = props.session.id;
	const [spec, setSpec] = useState('');
	const [specPath, setSpecPath] = useState('');
	const [specError, setSpecError] = useState('');
	const [specNotice, setSpecNotice] = useState('');
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') props.onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	/* The document is loaded from the session, never from a cached copy, so the
   editor always opens on what the gate reads. */
	useEffect(() => {
		if (props.mode !== 'spec') return;
		let cancelled = false;
		setSpecError('');
		setSpecNotice('');
		void loadModuleSpec(sessionId, specModule).then((loaded) => {
			if (cancelled) return;
			setSpec(loaded.text);
			setSpecPath(loaded.path);
		}).catch((error: unknown) => {
			if (cancelled) return;
			setSpec('');
			setSpecError(
				error instanceof Error
					? error.message
					: t('sandbox.workbench.spec.readFailed'),
			);
		});
		return () => {
			cancelled = true;
		};
	}, [props.mode, specModule]);

	const saveSpec = () => {
		if (saving) return;
		setSaving(true);
		setSpecError('');
		setSpecNotice('');
		void saveModuleSpec(sessionId, specModule, spec).then(() => {
			setSaving(false);
			setSpecNotice(t('sandbox.workbench.spec.saved'));
			props.onSpecSaved();
		}).catch((error: unknown) => {
			setSaving(false);
			setSpecError(
				error instanceof Error
					? error.message
					: t('sandbox.workbench.spec.saveFailed'),
			);
		});
	};

	<div class="workbench" role="dialog" aria-modal="true">
		<div class="workbench__panel">
			<header class="workbench__head">
				<Button
					size="sm"
					variant={props.mode === 'preview' ? 'primary' : 'secondary'}
					onClick={() => props.onMode('preview')}
				>{t('sandbox.work.preview')}</Button>
				<Button
					size="sm"
					variant={props.mode === 'diff' ? 'primary' : 'secondary'}
					onClick={() => props.onMode('diff')}
				>{t('sandbox.session.changes', { count: shown.length })}</Button>
				<Button
					size="sm"
					variant={props.mode === 'spec' ? 'primary' : 'secondary'}
					onClick={() => props.onMode('spec')}
				>{t('sandbox.workbench.specification')}</Button>
				<span class="ui-mono">
					{props.session.modules.length === 1
						? props.session.moduleId
						: t('sandbox.session.modules', {
								count: props.session.modules.length,
							})}
				</span>
				@if (props.session.modules.length > 1) {
					<select
						class="chat__picker"
						aria-label={t('sandbox.workbench.module')}
						value={props.activeModule}
						onChange={(event) => props.onModule(event.currentTarget.value)}
					>
						<option value="">{t('sandbox.session.module.all')}</option>
						@for (const module of props.session.modules; key module.id) {
							<option value={module.directory}>{module.id}</option>
						}
					</select>
				}
				<span class="sandbox__spacer"></span>
				@if (props.mode === 'preview') {
					<>
						<select
							class="ui-select"
							value={props.previewData}
							onChange={(event) => props.onPreviewData(
								event.currentTarget.value === 'bridge' ? 'bridge' : 'fixtures',
							)}
						>
							<option value="fixtures">{t('sandbox.work.fixtures')}</option>
							<option value="bridge">{t('sandbox.workbench.liveData')}</option>
						</select>
						<Button
							size="sm"
							variant={props.selecting ? 'primary' : 'secondary'}
							onClick={props.onToggleSelect}
						>
							<Icon name="filter" size={14} />
							{props.selecting
								? t('sandbox.workbench.selecting')
								: t('sandbox.workbench.selectElement')}
						</Button>
						<Button size="sm" onClick={props.onReload}>
							<Icon name="refresh" size={14} />
							{t('sandbox.workbench.reload')}
						</Button>
					</>
				}
				<Button size="sm" variant="ghost" onClick={props.onClose}>
					<Icon name="x" size={14} />
					{t('sandbox.common.close')}
				</Button>
			</header>
			@if (props.mode === 'preview') {
				<div
					class={[
						'workbench__body',
						props.selecting && 'preview-frame__wrap--selecting',
					]}
				>
					<iframe
						class="preview-frame"
						src={source}
						title={t('sandbox.work.previewTitle')}
					></iframe>
				</div>
			} @else if (props.mode === 'spec') {
				<div class="workbench__body workbench__body--scroll">
					<div class="spec-editor">
						<div class="spec-editor__bar">
							<span class="ui-mono">{specPath || specModule}</span>
							<span class="sandbox__spacer"></span>
							<Button
								size="sm"
								variant="primary"
								disabled={saving}
								onClick={saveSpec}
							>
								<Icon name="check" size={14} />
								{saving ? t('sandbox.common.saving') : t('sandbox.common.save')}
							</Button>
						</div>
						@if (specError) {
							<p class="spec-editor__error">{specError}</p>
						} @else if (specNotice) {
							<p class="spec-editor__notice">{specNotice}</p>
						}
						<textarea
							class="ui-textarea spec-editor__text"
							spellcheck={false}
							value={spec}
							onInput={(event) => setSpec(event.currentTarget.value)}
						></textarea>
					</div>
				</div>
			} @else {
				<div class="workbench__body workbench__body--scroll">
					<DiffPane
						diffs={props.diffs}
						activeModule={props.activeModule}
						onAsk={props.onAskAbout}
					/>
				</div>
			}
		</div>
	</div>
}
