import { act, createRoot, setIsOctaneActEnvironment } from 'octane';
import { afterEach, expect, it } from 'vitest';
import { configureApplicationBranding } from '../src/branding.ts';
import { SidebarBrand } from '../src/shell/BrandMark.tsrx';
import { MobileHeader } from '../src/shell/MobileHeader.tsrx';

setIsOctaneActEnvironment(true);

const mounted: (() => void)[] = [];

async function render(place: 'sidebar' | 'mobile') {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		if (place === 'sidebar') root.render(<SidebarBrand />);
		else root.render(<MobileHeader onToggle={() => {}} />);
	});
	mounted.push(() => {
		root.unmount();
		container.remove();
	});
	return container;
}

afterEach(() => {
	for (const unmount of mounted.splice(0)) unmount();
	configureApplicationBranding(null);
});

it('names the deployment in the sidebar and the mobile header', async () => {
	configureApplicationBranding({ appName: 'Acme Operations' });
	const sidebar = await render('sidebar');
	expect(sidebar.querySelector('.sidebar__wordmark')?.textContent).toBe(
		'Acme Operations',
	);
	const header = await render('mobile');
	expect(header.querySelector('.mobile-header__brand')?.textContent).toContain(
		'Acme Operations',
	);
});

/* A deployment that set no logo keeps the product mark, and one that set a
   logo shows it as decoration beside the wordmark that already names it. */
it('swaps the built-in mark for the stored logo', async () => {
	const product = await render('sidebar');
	expect(product.querySelector('img')).toBeNull();
	expect(product.querySelector('svg')).not.toBeNull();

	configureApplicationBranding({
		appName: 'Acme',
		logoUrl: '/brand/acme.svg',
	});
	const branded = await render('sidebar');
	const logo = branded.querySelector('img')!;
	expect(logo.getAttribute('src')).toBe('/brand/acme.svg');
	expect(logo.getAttribute('alt')).toBe('');
	expect(branded.querySelector('svg')).toBeNull();
});

it('ignores a logo address the declaration would refuse', async () => {
	configureApplicationBranding({
		appName: 'Acme',
		logoUrl: 'javascript:alert(1)',
	});
	const view = await render('sidebar');
	expect(view.querySelector('img')).toBeNull();
	expect(view.querySelector('svg')).not.toBeNull();
});
