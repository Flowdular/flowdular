import { useMemo } from 'octane';
import { t } from '@flowdular/client';
import { Button, CheckGrid, FormField } from '@flowdular/ui';
import type { CheckGroup, CheckOption } from '@flowdular/ui';
import { cell, createStore, useValue } from 'segment-state';
import type {
	AgentProcedure,
	CreateAgentProcedureInput,
	UpdateAgentProcedureInput,
} from '../domain/types.ts';

export interface AgentProcedureFormProps {
	readonly procedure: AgentProcedure | null;
	readonly tools: readonly string[];
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (input: | CreateAgentProcedureInput
	| UpdateAgentProcedureInput) => Promise<void>;
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

export function AgentProcedureForm(props: AgentProcedureFormProps) @{
	const formState = useMemo(
		() => createStore({
			requiredTools: cell<readonly string[]>(
				props.procedure?.requiredTools ?? [],
			),
		}),
		[],
	);
	const [requiredTools, setRequiredTools] = useValue(
		formState.state.requiredTools,
	);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const base: CreateAgentProcedureInput = {
			key: stringValue(form, 'key'),
			name: stringValue(form, 'name'),
			description: stringValue(form, 'description'),
			instructions: stringValue(form, 'instructions'),
			requiredTools,
			status: stringValue(
				form,
				'status',
			) as CreateAgentProcedureInput['status'],
		};
		await props.onSubmit(
			props.procedure
				? { ...base, expectedRevision: props.procedure.revision }
				: base,
		);
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label={t('agents.procedures.form.name')} required>
						<input
							class="ui-input"
							name="name"
							defaultValue={props.procedure?.name ?? ''}
							minlength={2}
							maxlength={120}
							autoFocus
							required
						/>
					</FormField>
					<FormField
						label={t('agents.procedures.form.key')}
						help={props.procedure
							? t('agents.procedures.form.keyFixed')
							: undefined}
						required
					>
						<input
							class="ui-input ui-mono"
							name="key"
							defaultValue={props.procedure?.key ?? ''}
							readonly={Boolean(props.procedure)}
							placeholder="invoice-triage"
							minlength={3}
							maxlength={64}
							required
						/>
					</FormField>
				</div>
				<FormField label={t('agents.procedures.form.description')} required>
					<input
						class="ui-input"
						name="description"
						defaultValue={props.procedure?.description ?? ''}
						placeholder={t('agents.procedures.form.descriptionPlaceholder')}
						maxlength={500}
						required
					/>
				</FormField>
				<FormField
					label={t('agents.procedures.form.instructions')}
					help={t('agents.procedures.form.instructionsHelp')}
					required
				>
					<textarea
						class="ui-textarea"
						name="instructions"
						defaultValue={props.procedure?.instructions ?? ''}
						placeholder={t('agents.procedures.form.instructionsPlaceholder')}
						minlength={8}
						maxlength={8_000}
						required
					></textarea>
				</FormField>
				<FormField label={t('agents.procedures.form.status')}>
					<select
						class="ui-select"
						name="status"
						defaultValue={props.procedure?.status ?? 'draft'}
					>
						<option value="draft">{t('agents.status.draft')}</option>
						<option value="active">{t('agents.status.active')}</option>
						<option value="archived">{t('agents.status.archived')}</option>
					</select>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">{t('agents.procedures.form.tools')}</span>
					@if (props.tools.length === 0) {
						<p class="agent-empty-note">{t(
							'agents.procedures.form.toolsEmpty',
						)}</p>
					} @else {
						<CheckGrid
							groups={toolGroups(props.tools)}
							value={requiredTools}
							mono
							onChange={setRequiredTools}
						/>
					}
					<span class="ui-help">{t('agents.procedures.form.toolsHelp')}</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{props.procedure
					? t('agents.procedures.form.revisionNote', {
							revision: props.procedure.revision + 1,
						})
					: t('agents.procedures.form.createNote')}
			</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('agents.common.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t('agents.common.saving')
						: props.procedure
							? t('agents.procedures.form.save')
							: t('agents.procedures.form.create')}
				</Button>
			</div>
		</div>
	</form>
}
