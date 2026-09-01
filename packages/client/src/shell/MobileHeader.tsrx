import { BrandMark, Icon } from '@coreloom/ui';

export function MobileHeader(props: { onToggle: () => void }) @{
	<header class="mobile-header">
		<a class="mobile-header__brand" href="/" aria-label="Coreloom home">
			<BrandMark size={22} />
			Coreloom
		</a>
		<button
			class="ui-btn ui-btn--secondary ui-btn--icon"
			type="button"
			aria-label="Toggle navigation"
			onClick={props.onToggle}
		>
			<Icon name="panel-left" size={16} />
		</button>
	</header>
}
