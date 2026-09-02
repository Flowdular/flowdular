import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { Head } from '@octanejs/seo';
import { LandingPage } from './LandingPage.tsrx';

export function App() @{
	<Head>
		<LandingPage />
	</Head>
}
