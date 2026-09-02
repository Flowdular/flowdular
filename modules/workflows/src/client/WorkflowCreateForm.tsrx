import { t } from '@coreloom/client';
import { Alert, Button, FormField } from '@coreloom/ui';
import { useMemo } from 'octane';
import { createStore } from 'segment-state';
import { useValue } from 'segment-state';
import type { CreateWorkflowDefinitionInput } from '../domain/types.ts';

export interface WorkflowCreateFormProps {
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (input: CreateWorkflowDefinitionInput) => void;
}

export function WorkflowCreateForm(props: WorkflowCreateFormProps) @{
	const form = useMemo(
		() => createStore({ key: '', name: '', description: '' }),
		[],
	);
	const [key, setKey] = useValue(form.state.key);
	const [name, setName] = useValue(form.state.name);
	const [description, setDescription] = useValue(form.state.description);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
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
						onInput={(event) => setName(event.currentTarget.value)}
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
						onInput={(event) => setKey(event.currentTarget.value)}
						pattern="[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+"
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
				<Button type="button" onClick={props.onCancel}>{t(
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
