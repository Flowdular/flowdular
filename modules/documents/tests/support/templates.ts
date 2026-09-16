import type { TemplateObjectSchema } from '../../src/domain/template-schema.ts';
import type { DocumentTemplateDefinition } from '../../src/domain/templates.ts';
import { DocumentTemplateRegistry } from '../../src/services/templates-service.ts';

export const OFFER_KEY = 'orders.core.offer';

export const OFFER_SCHEMA: TemplateObjectSchema = {
	type: 'object',
	required: ['customer', 'items'],
	properties: {
		customer: { type: 'string', maxLength: 200 },
		currency: { type: 'string', enum: ['PLN', 'EUR'] },
		items: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name'],
				properties: {
					name: { type: 'string' },
					price: { type: 'integer' },
				},
			},
		},
	},
};

export const OFFER_BODY = [
	'# Oferta dla {{ customer }}',
	'',
	'| Pozycja | Cena |',
	'| --- | ---: |',
	'{{#each items}}',
	'| {{ name }} | {{ price | money: currency }} |',
	'{{/each}}',
].join('\n');

export function offerDefinition(
	overrides: Partial<DocumentTemplateDefinition> = {},
): DocumentTemplateDefinition {
	return {
		key: OFFER_KEY,
		title: 'Offer',
		format: 'pdf',
		body: OFFER_BODY,
		inputSchema: OFFER_SCHEMA,
		locale: 'pl',
		layout: {
			title: 'Oferta {{ customer }}',
			footer: 'Strona {{ page }} z {{ pages }}',
		},
		...overrides,
	};
}

export function offerRegistry(
	overrides: Partial<DocumentTemplateDefinition> = {},
): DocumentTemplateRegistry {
	const registry = new DocumentTemplateRegistry();
	registry.register('orders.core', [offerDefinition(overrides)]);
	return registry;
}

export function offerInput(rows: number, customer = 'Spółka Żółw') {
	return {
		customer,
		currency: 'PLN',
		items: Array.from({ length: rows }, (_, index) => ({
			name: `Pozycja ${index + 1}`,
			price: (index + 1) * 100,
		})),
	};
}
