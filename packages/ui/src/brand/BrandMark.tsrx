import { MARK_VIEWBOX, MARK_WARP, MARK_WEFT } from './mark.ts';

export type BrandMarkTone = 'brand' | 'current' | 'inverse';

export interface BrandMarkProps {
	/** Rendered size in px. Never below 16. */
	size?: number;
	/** Copper weft. Reserved for large brand moments: splash, sign-in. */
	signature?: boolean;
	tone?: BrandMarkTone;
}

function warpFill(tone: BrandMarkTone): string {
	if (tone === 'current') return 'currentColor';
	if (tone === 'inverse') return '#ffffff';
	return 'var(--brand)';
}

function weftFill(tone: BrandMarkTone, signature: boolean): string {
	if (tone === 'current') return 'currentColor';
	if (!signature) return warpFill(tone);
	return tone === 'inverse' ? 'var(--copper-300)' : 'var(--brand-weft)';
}

export function BrandMark(props: BrandMarkProps) @{
	const size = props.size ?? 24;
	const tone = props.tone ?? 'brand';
	const warp = warpFill(tone);
	const weft = weftFill(tone, props.signature ?? false);
	<svg
		viewBox={MARK_VIEWBOX}
		width={size}
		height={size}
		aria-hidden="true"
		style="flex:0 0 auto"
	>
		<g fill={warp}>
			@for (const shape of MARK_WARP; key shape.id) {
				@if (shape.type === 'rect') {
					<rect
						x={shape.x}
						y={shape.y}
						width={shape.width}
						height={shape.height}
					/>
				} @else {
					<circle cx={shape.cx} cy={shape.cy} r={shape.r} />
				}
			}
		</g>
		<g fill={weft}>
			@for (const shape of MARK_WEFT; key shape.id) {
				@if (shape.type === 'rect') {
					<rect
						x={shape.x}
						y={shape.y}
						width={shape.width}
						height={shape.height}
					/>
				} @else {
					<circle cx={shape.cx} cy={shape.cy} r={shape.r} />
				}
			}
		</g>
	</svg>
}
