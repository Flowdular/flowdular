import { t } from '@coreloom/client';
import { Alert, Button, FormField, Icon } from '@coreloom/ui';

export interface WorkflowTestPanelProps {
	readonly inputText: string;
	readonly fixtureCount: number;
	readonly busy: boolean;
	readonly canValidate: boolean;
	readonly canExecute: boolean;
	readonly published: boolean;
	readonly error: string;
	readonly onInput: (value: string) => void;
	readonly onOpenFixtures: () => void;
	readonly onDryRun: () => void;
	readonly onSimulate: () => void;
	readonly onRunLive: () => void;
}

export function WorkflowTestPanel(props: WorkflowTestPanelProps) @{
	<section class="workflow-panel" aria-label={t('workflows.test.label')}>
		<div class="workflow-panel-head">
			<b>{t('workflows.test.title')}</b>
			<small>{t('workflows.test.description')}</small>
		</div>
		<div class="workflow-panel__body ui-form">
			<FormField
				label={t('workflows.test.input')}
				help={t('workflows.test.inputHelp')}
			>
				<textarea
					class="ui-textarea ui-mono"
					value={props.inputText}
					onInput={(event) => props.onInput(event.currentTarget.value)}
					spellcheck="false"
				/>
			</FormField>
			<div class="workflow-fixture-summary">
				<span class="ui-cell">
					<b>{t('workflows.test.fixtures')}</b>
					<small>{t('workflows.test.fixtureCount', {
						count: props.fixtureCount,
					})}</small>
				</span>
				<Button
					disabled={props.busy || !props.canExecute}
					onClick={props.onOpenFixtures}
				>
					<Icon name="settings" size={14} />
					{t('workflows.test.configureFixtures')}
				</Button>
			</div>
			@if (props.error) {
				<Alert>{props.error}</Alert>
			}
			<div class="ui-form__actions workflow-test-actions">
				<Button
					disabled={props.busy || !props.canValidate}
					onClick={props.onDryRun}
				>
					<Icon name="check" size={14} />
					{t('workflows.test.dryRun')}
				</Button>
				<Button
					disabled={props.busy || !props.canExecute}
					onClick={props.onSimulate}
				>
					<Icon name="flask" size={14} />
					{t('workflows.test.simulate')}
				</Button>
				<Button
					variant="primary"
					disabled={props.busy || !props.canExecute || !props.published}
					onClick={props.onRunLive}
				>
					<Icon name="play" size={14} />
					{t('workflows.test.runLive')}
				</Button>
			</div>
			@if (!props.published) {
				<small class="ui-help">{t('workflows.test.publishFirst')}</small>
			}
		</div>
	</section>
}
