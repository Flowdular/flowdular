import { t } from '@flowdular/client';
import { Alert, Button, FormField } from '@flowdular/ui';
import { useMemo } from 'octane';
import { createStore } from 'segment-state';
import { useValue } from 'segment-state';
import type { CreateWorkflowDefinitionInput } from '../domain/types.ts';
import { suggestedWorkflowKey, WORKFLOW_KEY_PATTERN } from './create-model.ts';

export interface WorkflowCreateFormProps {
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (input: CreateWorkflowDefinitionInput) => void;
}

export function WorkflowCreateForm(props: WorkflowCreateFormProps) @{
	const form = useMemo(
		() => createStore({ key: '', name: '', description: '', keyEdited: false }),
		[],
	);
	const [key, setKey] = useValue(form.state.key);
	const [name, setName] = useValue(form.state.name);
	const [description, setDescription] = useValue(form.state.description);
	const [keyEdited, setKeyEdited] = useValue(form.state.keyEdited);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (props.busy) return;
		props.onSubmit({
			key: key.trim(),
			name: name.trim(),
			description: description.trim(),
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField
					label={t('workflows.create.name')}
					help={t('workflows.create.nameHelp')}
					required
				>
					<input
						class="ui-input"
						value={name}
						onInput={(event) => {
							setName(event.currentTarget.value);
							if (!keyEdited) setKey(
								suggestedWorkflowKey(event.currentTarget.value),
							);
						}}
						disabled={props.busy}
						minlength={2}
						maxlength={160}
						autoFocus
						required
					/>
				</FormField>
				<FormField
					label={t('workflows.create.key')}
					help={t('workflows.create.keyHelp')}
					required
				>
					<input
						class="ui-input ui-mono"
						value={key}
						onInput={(event) => {
							setKeyEdited(true);
							setKey(event.currentTarget.value);
						}}
						pattern={WORKFLOW_KEY_PATTERN}
						title={t('workflows.create.keyHelp')}
						minlength={3}
						disabled={props.busy}
						maxlength={120}
						required
					/>
				</FormField>
				<FormField
					label={t('workflows.create.description')}
					help={t('workflows.create.descriptionHelp')}
				>
					<textarea
						class="ui-textarea"
						value={description}
						disabled={props.busy}
						onInput={(event) => setDescription(event.currentTarget.value)}
						maxlength={500}
					/>
				</FormField>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('workflows.create.note')}</small>
			<div class="ui-form__actions">
				<Button type="button" disabled={props.busy} onClick={props.onCancel}>{t(
					'workflows.common.cancel',
				)}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t('workflows.create.creating')
						: t('workflows.create.submit')}
				</Button>
			</div>
		</div>
	</form>
}
