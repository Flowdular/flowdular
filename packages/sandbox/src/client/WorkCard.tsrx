import { useEffect } from 'octane';
import { Button, Icon, Tag } from '@flowdular/ui';
import type { SandboxSession } from '../server/sessions.ts';
import { DiffPane, type ModuleDiff } from './DiffPane.tsrx';
import { useTranslation } from './i18n.ts';

export type WorkCardMode = 'preview' | 'code';

export interface WorkCardProps {
	readonly session: SandboxSession;
	readonly diffs: readonly ModuleDiff[];
	readonly mode: WorkCardMode;
	readonly nonce: number;
	/* The module the card shows; empty means every module of the session. */
	readonly activeModule: string;
	readonly previewData: 'fixtures' | 'bridge';
	readonly onMode: (mode: WorkCardMode) => void;
	readonly onOpen: () => void;
	readonly onReload: () => void;
	readonly onAskAbout: (path: string) => void;
}

/* The card floats beside the conversation and carries both surfaces the work
   produces: the running module and its diff. It is a viewport, so a click
   opens the same content full screen where it becomes interactive. */
/* The preview renders at a real workspace width and is scaled to the card, so
   the card shows the desktop layout rather than a narrow rendering. The factor
   depends on the card width, which only the browser knows. */
const PREVIEW_WIDTH = 1440;

function fitPreview(): void {
	const viewport = document.querySelector<HTMLElement>('.work-card__viewport');
	const frame = viewport?.querySelector<HTMLElement>('.preview-frame');
	if (!viewport || !frame) return;
	const scale = viewport.clientWidth / PREVIEW_WIDTH;
	if (scale <= 0) return;
	frame.style.width = `${PREVIEW_WIDTH}px`;
	frame.style.height = `${Math.round(viewport.clientHeight / scale)}px`;
	frame.style.transform = `scale(${scale})`;
}

export function WorkCard(props: WorkCardProps) @{
	const { t } = useTranslation();
	const source =
		'/preview/' + props.session.id + '?n=' + props.nonce +
		(props.activeModule ? '&module=' + props.activeModule : '');
	const shown =
		props.activeModule
			? props.diffs.filter((diff) => diff.module === props.activeModule)
			: props.diffs;

	useEffect(() => {
		fitPreview();
		const observer = new ResizeObserver(() => fitPreview());
		const viewport = document.querySelector('.work-card__viewport');
		if (viewport) observer.observe(viewport);
		return () => observer.disconnect();
	}, [props.mode, props.nonce]);

	<article class="work-card">
		<header class="work-card__head">
			<Button
				size="sm"
				variant={props.mode === 'preview' ? 'primary' : 'ghost'}
				onClick={() => props.onMode('preview')}
			>{t('sandbox.work.preview')}</Button>
			<Button
				size="sm"
				variant={props.mode === 'code' ? 'primary' : 'ghost'}
				onClick={() => props.onMode('code')}
			>{t('sandbox.work.code', { count: shown.length })}</Button>
			<span class="ui-mono">
				{props.activeModule
					? 'modules/' + props.activeModule
					: props.session.modules.length === 1
						? props.session.moduleId
						: t('sandbox.session.modules', {
								count: props.session.modules.length,
							})}
			</span>
			<span class="sandbox__spacer"></span>
			@if (props.mode === 'preview') {
				<Tag tone={props.previewData === 'bridge' ? 'info' : 'neutral'}>
					{props.previewData === 'bridge'
						? t('sandbox.work.liveData')
						: t('sandbox.work.fixtures')}
				</Tag>
			}
			<Button size="sm" variant="ghost" onClick={props.onReload}>
				<Icon name="refresh" size={14} />
			</Button>
			<Button size="sm" variant="ghost" onClick={props.onOpen}>
				<Icon name="external" size={14} />
			</Button>
		</header>

		@if (props.mode === 'preview') {
			<div class="work-card__stage">
				<div class="work-card__viewport">
					<iframe
						class="preview-frame"
						src={source}
						title={t('sandbox.work.previewTitle')}
					></iframe>
				</div>
				<button
					class="work-card__open"
					type="button"
					onClick={props.onOpen}
					aria-label={t('sandbox.work.openFull')}
				>
					<span class="work-card__hint">
						<Icon name="external" size={14} />
						{t('sandbox.work.open')}
					</span>
				</button>
			</div>
		} @else {
			<div class="work-card__stage work-card__stage--code">
				<DiffPane
					diffs={props.diffs}
					activeModule={props.activeModule}
					onAsk={props.onAskAbout}
				/>
			</div>
		}
	</article>
}
