import { useMemo } from 'octane';
import { Alert, Button, FormField } from '@flowdular/sdk/ui';
import { t } from '@flowdular/sdk/client';
import { cell, createStore, useValue } from 'segment-state';
import type { CatalogItem, CatalogItemKind } from '../domain/types.ts';

export interface CatalogItemFormProps {
	readonly item: CatalogItem | null;
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onArchive: (() => void) | undefined;
	readonly onRestore: (() => void) | undefined;
	readonly onDelete: (() => void) | undefined;
	readonly onHistory: (() => void) | undefined;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function CatalogItemForm(props: CatalogItemFormProps) @{
	const formState = useMemo(
		() => createStore({
			name: props.item?.name ?? '',
			sku: props.item?.sku ?? '',
			kind: cell<CatalogItemKind>(props.item?.kind ?? 'product'),
			unit: props.item?.unit ?? 'each',
			basePriceMinor: String(props.item?.basePriceMinor ?? 0),
			currency: props.item?.currency ?? 'EUR',
		}),
		[],
	);
	const [name, setName] = useValue(formState.state.name);
	const [sku, setSku] = useValue(formState.state.sku);
	const [kind, setKind] = useValue(formState.state.kind);
	const [unit, setUnit] = useValue(formState.state.unit);
	const [basePriceMinor, setBasePriceMinor] = useValue(
		formState.state.basePriceMinor,
	);
	const [currency, setCurrency] = useValue(formState.state.currency);

	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label={t('catalog.form.name')} required>
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
					<FormField label={t('catalog.form.sku')} required>
						<input
							class="ui-input ui-mono"
							name="sku"
							value={sku}
							onInput={(event) => setSku(event.currentTarget.value)}
							disabled={props.item !== null}
							maxlength={64}
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label={t('catalog.form.kind')}>
						<select
							class="ui-select"
							name="kind"
							value={kind}
							onInput={(event) => setKind(
								event.currentTarget.value as CatalogItemKind,
							)}
						>
							<option value="product">{t('catalog.kind.product')}</option>
							<option value="service">{t('catalog.kind.service')}</option>
						</select>
					</FormField>
					<FormField label={t('catalog.form.unit')} required>
						<input
							class="ui-input"
							name="unit"
							value={unit}
							onInput={(event) => setUnit(event.currentTarget.value)}
							maxlength={24}
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField
						label={t('catalog.form.price')}
						help={t('catalog.form.priceHelp')}
						required
					>
						<input
							class="ui-input"
							name="basePriceMinor"
							type="number"
							min="0"
							step="1"
							value={basePriceMinor}
							onInput={(event) => setBasePriceMinor(event.currentTarget.value)}
							required
						/>
					</FormField>
					<FormField label={t('catalog.form.currency')} required>
						<input
							class="ui-input ui-mono"
							name="currency"
							value={currency}
							onInput={(event) => setCurrency(event.currentTarget.value)}
							minlength={3}
							maxlength={3}
							required
						/>
					</FormField>
				</div>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				@if (props.item) {
					<>
						<div class="ui-form__section">
							<div class="ui-form__section-head">
								<b>{t('catalog.lifecycle.title')}</b>
								<small>{t('catalog.lifecycle.description')}</small>
							</div>
							<div class="ui-form__actions">
								@if (props.onHistory) {
									<Button
										type="button"
										disabled={props.busy}
										onClick={props.onHistory}
									>{t('catalog.lifecycle.history')}</Button>
								}
								@if (props.onArchive) {
									<Button
										type="button"
										disabled={props.busy}
										onClick={props.onArchive}
									>{t('catalog.lifecycle.archive')}</Button>
								}
								@if (props.onRestore) {
									<Button
										type="button"
										disabled={props.busy}
										onClick={props.onRestore}
									>{t('catalog.lifecycle.restore')}</Button>
								}
							</div>
						</div>
						@if (props.onDelete) {
							<div class="ui-form__section ui-form__section--danger">
								<div class="ui-form__section-head">
									<b>{t('catalog.delete.title')}</b>
									<small>{t('catalog.delete.drawerDescription')}</small>
								</div>
								<div class="ui-form__actions">
									<Button
										type="button"
										variant="danger"
										disabled={props.busy}
										onClick={props.onDelete}
									>{t('catalog.lifecycle.delete')}</Button>
								</div>
							</div>
						}
					</>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t(
				props.item ? 'catalog.form.editNote' : 'catalog.form.note',
			)}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('catalog.form.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t(props.item ? 'catalog.form.saving' : 'catalog.form.submitting')
						: t(props.item ? 'catalog.form.save' : 'catalog.form.submit')}
				</Button>
			</div>
		</div>
	</form>
}
