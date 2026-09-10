import { useEffect } from 'octane';
import { Button, Icon } from '@flowdular/ui';
import type { SandboxSession } from '../server/sessions.ts';
import { SpecEditor } from './SpecEditor.tsrx';
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
	const specModule = props.activeModule || props.session.modules[0]!.directory;
	const sessionId = props.session.id;

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') props.onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

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
						value={props.mode === 'spec' ? specModule : props.activeModule}
						onChange={(event) => props.onModule(event.currentTarget.value)}
					>
						@if (props.mode !== 'spec') {
							<option value="">{t('sandbox.session.module.all')}</option>
						}
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
					<SpecEditor
						key={sessionId + '/' + specModule}
						sessionId={sessionId}
						module={specModule}
						onSaved={props.onSpecSaved}
					/>
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
