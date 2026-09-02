import { useMemo } from 'octane';
import { Alert, Button, FormField, VariableTextarea } from '@coreloom/ui';
import { useTranslation } from '@coreloom/client';
import { createStore, useValue } from 'segment-state';
import { EXPENSE_NOTE_VARIABLES } from '../domain/variables.ts';

export interface ExpenseClaimFormProps {
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function ExpenseClaimForm(props: ExpenseClaimFormProps) @{
	const { t } = useTranslation();
	const noteVariables = EXPENSE_NOTE_VARIABLES.map(
		(variable) => ({
			...variable,
			label: t('expenses.variables.' + variable.key + '.label'),
		}),
	);
	const formState = useMemo(
		() => createStore({ currency: 'EUR', note: '' }),
		[],
	);
	const [currency, setCurrency] = useValue(formState.state.currency);
	const [note, setNote] = useValue(formState.state.note);

	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label={t('expenses.form.title')} required>
						<input
							class="ui-input"
							name="title"
							maxlength={160}
							autoFocus
							required
						/>
					</FormField>
					<FormField
						label={t('expenses.form.amount')}
						help={t('expenses.form.amountHelp')}
						required
					>
						<input
							class="ui-input"
							name="amount"
							type="number"
							min="0"
							step="0.01"
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label={t('expenses.form.currency')} required>
						<input
							class="ui-input ui-mono"
							name="currency"
							value={currency}
							onInput={(event) => setCurrency(
								event.currentTarget.value.toUpperCase(),
							)}
							minlength={3}
							maxlength={3}
							required
						/>
					</FormField>
					<FormField label={t('expenses.form.category')} required>
						<select class="ui-select" name="category" required>
							<option value="travel">{t('expenses.category.travel')}</option>
							<option value="meals">{t('expenses.category.meals')}</option>
							<option value="equipment">{t(
								'expenses.category.equipment',
							)}</option>
							<option value="other">{t('expenses.category.other')}</option>
						</select>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label={t('expenses.form.date')} required>
						<input class="ui-input" name="expenseDate" type="date" required />
					</FormField>
				</div>
				<FormField
					label={t('expenses.form.note')}
					help={t('expenses.form.noteHelp')}
				>
					<VariableTextarea
						name="note"
						value={note}
						onInput={setNote}
						variables={noteVariables}
						label={t('expenses.form.note')}
						insertLabel={t('expenses.template.insert')}
						variablesLabel={t('expenses.template.available')}
						emptyLabel={t('expenses.template.empty')}
						placeholder={t('expenses.form.notePlaceholder')}
						sampleValues={{
							'expense.title': t('expenses.template.sample.title'),
							'expense.amount': '42.50',
							'expense.currency': currency,
							'expense.category': t('expenses.category.meals'),
							'expense.date': '2026-09-02',
						}}
						maxLength={2000}
					/>
				</FormField>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('expenses.form.footer')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('expenses.action.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t('expenses.action.creating')
						: t('expenses.action.create')}
				</Button>
			</div>
		</div>
	</form>
}
