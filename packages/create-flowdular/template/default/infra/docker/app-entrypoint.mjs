import { installDatabaseUrls } from './database-urls.mjs';

if (process.env.FD_DATABASE_ADAPTER === 'postgresql') {
	installDatabaseUrls(process.env);
}
