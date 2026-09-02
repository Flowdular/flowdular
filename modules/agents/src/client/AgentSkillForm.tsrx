import { useMemo } from 'octane';
import { t } from '@coreloom/client';
import { Button, CheckGrid, FormField } from '@coreloom/ui';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type {
	AgentSkill,
	CreateAgentSkillInput,
	UpdateAgentSkillInput,
} from '../domain/types.ts';

export interface AgentSkillFormProps {
	readonly skill: AgentSkill | null;
	readonly tools: readonly string[];
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (input: | CreateAgentSkillInput
	| UpdateAgentSkillInput) => Promise<void>;
}

function toolGroups(tools: readonly string[]): readonly CheckGroup[] {
	const groups = new Map<string, CheckOption[]>();
	for (const tool of tools) {
		const namespace = tool.split('.')[0] ?? tool;
		const options = groups.get(namespace) ?? [];
		options.push({
			value: tool,
			label: tool.slice(namespace.length + 1) || tool,
		});
		groups.set(namespace, options);
	}
	return [...groups].map(([label, options]) => ({ label, options }));
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

export function AgentSkillForm(props: AgentSkillFormProps) @{
	const formState = useMemo(
		() => createStore({
			requiredTools: cell<readonly string[]>(props.skill?.requiredTools ?? []),
		}),
		[],
	);
	const [requiredTools, setRequiredTools] = useValue(
		formState.state.requiredTools,
	);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const base: CreateAgentSkillInput = {
			key: stringValue(form, 'key'),
			name: stringValue(form, 'name'),
			description: stringValue(form, 'description'),
			instructions: stringValue(form, 'instructions'),
			requiredTools,
			status: stringValue(form, 'status') as CreateAgentSkillInput['status'],
		};
		await props.onSubmit(
			props.skill ? { ...base, expectedRevision: props.skill.revision } : base,
		);
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label={t('agents.skills.form.name')} required>
						<input
							class="ui-input"
							name="name"
							defaultValue={props.skill?.name ?? ''}
							minlength={2}
							maxlength={120}
							autoFocus
							required
						/>
					</FormField>
					<FormField
						label={t('agents.skills.form.key')}
						help={props.skill ? t('agents.skills.form.keyFixed') : undefined}
						required
					>
						<input
							class="ui-input ui-mono"
							name="key"
							defaultValue={props.skill?.key ?? ''}
							readonly={Boolean(props.skill)}
							placeholder="invoice-triage"
							minlength={3}
							maxlength={64}
							required
						/>
					</FormField>
				</div>
				<FormField label={t('agents.skills.form.description')} required>
					<input
						class="ui-input"
						name="description"
						defaultValue={props.skill?.description ?? ''}
						placeholder={t('agents.skills.form.descriptionPlaceholder')}
						maxlength={500}
						required
					/>
				</FormField>
				<FormField
					label={t('agents.skills.form.instructions')}
					help={t('agents.skills.form.instructionsHelp')}
					required
				>
					<textarea
						class="ui-textarea"
						name="instructions"
						defaultValue={props.skill?.instructions ?? ''}
						placeholder={t('agents.skills.form.instructionsPlaceholder')}
						minlength={8}
						maxlength={8_000}
						required
					></textarea>
				</FormField>
				<FormField label={t('agents.skills.form.status')}>
					<select
						class="ui-select"
						name="status"
						defaultValue={props.skill?.status ?? 'draft'}
					>
						<option value="draft">{t('agents.status.draft')}</option>
						<option value="active">{t('agents.status.active')}</option>
						<option value="archived">{t('agents.status.archived')}</option>
					</select>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">{t('agents.skills.form.tools')}</span>
					@if (props.tools.length === 0) {
						<p class="agent-empty-note">{t('agents.skills.form.toolsEmpty')}</p>
					} @else {
						<CheckGrid
							groups={toolGroups(props.tools)}
							value={requiredTools}
							mono
							onChange={setRequiredTools}
						/>
					}
					<span class="ui-help">{t('agents.skills.form.toolsHelp')}</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{props.skill
					? t('agents.skills.form.revisionNote', {
							revision: props.skill.revision + 1,
						})
					: t('agents.skills.form.createNote')}
			</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('agents.common.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t('agents.common.saving')
						: props.skill
							? t('agents.skills.form.save')
							: t('agents.skills.form.create')}
				</Button>
			</div>
		</div>
	</form>
}
