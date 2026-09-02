import { useMemo } from 'octane';
import { Alert, Button, FormField } from '@coreloom/ui';
import { t } from '@coreloom/client';
import { cell, createStore, useValue } from 'segment-state';
import type { Party, PartyKind } from '../domain/types.ts';

export interface PartyFormProps {
	readonly party: Party | null;
	readonly defaultKind: Exclude<PartyKind, 'both'>;
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onArchive: (() => Promise<void>) | undefined;
	readonly onRestore: (() => Promise<void>) | undefined;
	readonly onDelete: (() => void) | undefined;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function PartyForm(props: PartyFormProps) @{
	const formState = useMemo(
		() => createStore({
			name: props.party?.name ?? '',
			kind: cell<PartyKind>(props.party?.kind ?? props.defaultKind),
			email: props.party?.email ?? '',
			phone: props.party?.phone ?? '',
			vatId: props.party?.vatId ?? '',
		}),
		[],
	);
	const [name, setName] = useValue(formState.state.name);
	const [kind, setKind] = useValue(formState.state.kind);
	const [email, setEmail] = useValue(formState.state.email);
	const [phone, setPhone] = useValue(formState.state.phone);
	const [vatId, setVatId] = useValue(formState.state.vatId);

	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField label={t('parties.form.name')} required>
					<input
						class="ui-input"
						name="name"
						value={name}
						onInput={(event) => setName(event.currentTarget.value)}
						minlength={2}
						maxlength={160}
						autoFocus
						required
					/>
				</FormField>
				<FormField label={t('parties.form.kind')}>
					<select
						class="ui-select"
						name="kind"
						value={kind}
						onInput={(event) => setKind(event.currentTarget.value as PartyKind)}
					>
						<option value="customer">{t('parties.kind.customer')}</option>
						<option value="supplier">{t('parties.kind.supplier')}</option>
						<option value="both">{t('parties.kind.both')}</option>
					</select>
				</FormField>
				<div class="ui-form__row">
					<FormField
						label={t('parties.form.email')}
						help={t('parties.form.emailHelp')}
					>
						<input
							class="ui-input"
							name="email"
							type="email"
							value={email}
							onInput={(event) => setEmail(event.currentTarget.value)}
							maxlength={254}
						/>
					</FormField>
					<FormField label={t('parties.form.phone')}>
						<input
							class="ui-input"
							name="phone"
							type="tel"
							value={phone}
							onInput={(event) => setPhone(event.currentTarget.value)}
							maxlength={40}
						/>
					</FormField>
				</div>
				<FormField
					label={t('parties.form.vatId')}
					help={t('parties.form.vatIdHelp')}
				>
					<input
						class="ui-input ui-mono"
						name="vatId"
						value={vatId}
						onInput={(event) => setVatId(event.currentTarget.value)}
						pattern="[A-Za-z0-9]*"
						maxlength={20}
					/>
				</FormField>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				@if (
					props.party && (props.onArchive || props.onRestore || props.onDelete)
				) {
					<div class="ui-form__section ui-form__section--danger">
						<div class="ui-form__section-head">
							<b>{t('parties.lifecycle.title')}</b>
							<small>{t('parties.lifecycle.description')}</small>
						</div>
						<div class="ui-form__actions">
							@if (props.onArchive) {
								<Button
									type="button"
									disabled={props.busy}
									onClick={() => void props.onArchive!()}
								>{t('parties.lifecycle.archive')}</Button>
							}
							@if (props.onRestore) {
								<Button
									type="button"
									disabled={props.busy}
									onClick={() => void props.onRestore!()}
								>{t('parties.lifecycle.restore')}</Button>
							}
							@if (props.onDelete) {
								<Button
									type="button"
									variant="danger"
									disabled={props.busy}
									onClick={props.onDelete}
								>{t('parties.lifecycle.delete')}</Button>
							}
						</div>
					</div>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('parties.form.note')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('parties.action.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? props.party
							? t('parties.action.saving')
							: t('parties.action.creating')
						: props.party
							? t('parties.action.save')
							: t('parties.action.create')}
				</Button>
			</div>
		</div>
	</form>
}
