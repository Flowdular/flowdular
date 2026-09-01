import { useMemo } from 'octane';
import { Alert, Button, FormField } from '@coreloom/ui';
import { createStore, useValue } from 'segment-state';

export interface CatalogItemFormProps {
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function CatalogItemForm(props: CatalogItemFormProps) @{
	const formState = useMemo(
		() => createStore({ unit: 'each', basePriceMinor: '0', currency: 'EUR' }),
		[],
	);
	const [unit, setUnit] = useValue(formState.state.unit);
	const [basePriceMinor, setBasePriceMinor] = useValue(
		formState.state.basePriceMinor,
	);
	const [currency, setCurrency] = useValue(formState.state.currency);

	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label="Name" required>
						<input
							class="ui-input"
							name="name"
							minlength={2}
							maxlength={160}
							autoFocus
							required
						/>
					</FormField>
					<FormField label="SKU" required>
						<input
							class="ui-input ui-mono"
							name="sku"
							maxlength={64}
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label="Kind">
						<select class="ui-select" name="kind">
							<option value="product">Product</option>
							<option value="service">Service</option>
						</select>
					</FormField>
					<FormField label="Unit" required>
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
						label="Price, minor units"
						help="1000 is 10.00 in the currency below."
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
					<FormField label="Currency" required>
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
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>The SKU is tenant-scoped and cannot change later.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy ? 'Creating…' : 'Create item'}
				</Button>
			</div>
		</div>
	</form>
}
