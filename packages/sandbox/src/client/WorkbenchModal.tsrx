import { useEffect } from 'octane';
import { Button, Icon } from '@coreloom/ui';
import type { FileDiff } from '../server/diff.ts';
import type { SandboxSession } from '../server/sessions.ts';
import { DiffPane } from './DiffPane.tsrx';

export type WorkbenchMode = 'preview' | 'diff';

export interface WorkbenchModalProps {
	readonly mode: WorkbenchMode;
	readonly session: SandboxSession;
	readonly diffs: readonly FileDiff[];
	readonly nonce: number;
	readonly selecting: boolean;
	readonly previewData: 'fixtures' | 'bridge';
	readonly onMode: (mode: WorkbenchMode) => void;
	readonly onToggleSelect: () => void;
	readonly onReload: () => void;
	readonly onPreviewData: (mode: 'fixtures' | 'bridge') => void;
	readonly onAskAbout: (path: string) => void;
	readonly onClose: () => void;
}

/* Full screen is where the module is actually worked on: the preview is
   interactive here, and the diff finally has the width it needs. */
export function WorkbenchModal(props: WorkbenchModalProps) @{
	const source =
		'/preview/' + props.session.id + '?n=' + props.nonce +
		(props.selecting ? '&select=1' : '');

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
				>
					Preview
				</Button>
				<Button
					size="sm"
					variant={props.mode === 'diff' ? 'primary' : 'secondary'}
					onClick={() => props.onMode('diff')}
				>
					{'Changes (' + props.diffs.length + ')'}
				</Button>
				<span class="ui-mono">{props.session.moduleId}</span>
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
							<option value="fixtures">Fixtures</option>
							<option value="bridge">Live platform data</option>
						</select>
						<Button
							size="sm"
							variant={props.selecting ? 'primary' : 'secondary'}
							onClick={props.onToggleSelect}
						>
							<Icon name="filter" size={14} />
							{props.selecting ? 'Selecting' : 'Select element'}
						</Button>
						<Button size="sm" onClick={props.onReload}>
							<Icon name="refresh" size={14} />
							Reload
						</Button>
					</>
				}
				<Button size="sm" variant="ghost" onClick={props.onClose}>
					<Icon name="x" size={14} />
					Close
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
						title="Module preview"
					></iframe>
				</div>
			} @else {
				<div class="workbench__body workbench__body--scroll">
					<DiffPane diffs={props.diffs} onAsk={props.onAskAbout} />
				</div>
			}
		</div>
	</div>
}
