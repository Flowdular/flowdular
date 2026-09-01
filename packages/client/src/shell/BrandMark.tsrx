import { BrandMark } from '@coreloom/ui';

export function SidebarBrand() @{
	<a class="sidebar__home" href="/" aria-label="Coreloom home">
		<BrandMark size={22} />
		<span class="sidebar__wordmark">Coreloom</span>
	</a>
}
