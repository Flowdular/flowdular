export interface BrandHeaderOptions {
	readonly title?: string;
	readonly subtitle?: string;
	readonly color?: boolean;
	readonly columns?: number;
	readonly terminal?: boolean;
}
export function renderBrandHeader(options?: BrandHeaderOptions): string;
