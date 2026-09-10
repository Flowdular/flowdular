import { Alert, Drawer, Tag } from '@flowdular/ui';
import type { GateResult } from '../server/gates.ts';
import { gateLabel } from './session-labels.ts';
import { useTranslation } from './i18n.ts';

export function GateResults(props: {
	readonly results: readonly GateResult[];
	readonly running: boolean;
	readonly error: string;
	readonly onClose: () => void;
}) @{
	const { t } = useTranslation();
	<Drawer
		open
		title={t('sandbox.gates.title')}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			<div class="ui-view">
				@if (props.running) {
					<p role="status">{t('sandbox.gates.running')}</p>
				} @else if (props.error) {
					<Alert>{props.error}</Alert>
				} @else if (props.results.length === 0) {
					<Alert tone="warning">{t('sandbox.app.gates.none')}</Alert>
				}
				@for (const gate of props.results; key (gate.module ?? '') + ':' +
					gate.id) {
					<section class="ui-card">
						<div class="ui-card__head">
							<h3 class="ui-card__title">{gateLabel(gate.id)}</h3>
							<Tag
								tone={gate.status === 'passed'
									? 'success'
									: gate.status === 'failed'
										? 'danger'
										: 'warning'}
							>{t('sandbox.gates.status.' + gate.status)}</Tag>
						</div>
						<div class="ui-card__body">
							<p>{t('sandbox.gates.module', {
								module: gate.module ?? t('sandbox.gates.workspace'),
							})}</p>
							<p>{t('sandbox.gates.explain.' + gate.status)}</p>
							@if (gate.output || gate.command) {
								<details open={gate.status === 'failed'}>
									<summary>{t('sandbox.gates.details')}</summary>
									<div class="ui-table-wrap">
										<pre class="ui-code">{gate.output || gate.command}</pre>
									</div>
								</details>
							}
						</div>
					</section>
				}
			</div>
		</div>
	</Drawer>
}
