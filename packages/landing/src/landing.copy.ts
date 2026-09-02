import type { LandingLocale } from './locale.ts';

/* Copy for the public landing, one object per locale. `pl` is typed from `en`,
   so a missing or renamed key fails typecheck instead of rendering a key. */

const en = {
	seo: {
		title:
			'The open source agentic foundation framework for business platforms',
		description:
			'Coreloom ships the production core: accounts, workspaces, permissions, module composition, an agent runtime, workflows, a CLI and a spec-first sandbox. MIT licensed core, enterprise license available.',
		imageAlt: 'Coreloom agentic foundation framework',
	},
	nav: {
		home: 'Coreloom home',
		label: 'Landing page navigation',
		platform: 'Platform',
		how: 'How it ships',
		sandbox: 'Sandbox',
		modules: 'Modules',
		agents: 'Agents',
		openSource: 'Open source',
		licensing: 'Licensing',
		product: 'Product',
		productMenu: 'Product sections',
		platformHint: 'Accounts, permissions, composition, agents',
		modulesHint: 'The contract every module follows',
		agentsHint: 'Agent runtime and workflow canvas',
		openSourceHint: 'MIT core, public repository',
		github: 'Coreloom on GitHub',
		language: 'Language',
		menu: 'Menu',
		signIn: 'Sign in',
		create: 'Create workspace',
	},
	hero: {
		badge: 'Open source · MIT core',
		kicker: 'Agentic foundation framework',
		title: 'Your platform core,',
		titleAccent: 'already built.',
		description:
			'The open source foundation for modular business software. Accounts, permissions, module composition, agents and workflows already run, so your team ships modules instead of plumbing.',
		primary: 'Create your workspace',
		secondary: 'View on GitHub',
		note: 'MIT licensed core. Self-host anywhere. Enterprise license available.',
		cloneLabel: 'Clone the repository',
		copy: 'Copy',
		copied: 'Copied',
	},
	demo: {
		label: 'A Coreloom workspace while a new module is enabled from the CLI',
		terminal: 'Terminal',
		groups: {
			workspace: 'Workspace',
			operations: 'Operations',
			administration: 'Administration',
			development: 'Development',
		},
		nav: {
			dashboard: 'Dashboard',
			parties: 'Parties',
			catalog: 'Catalog',
			expenses: 'Expenses',
			orders: 'Orders',
			users: 'Users',
			roles: 'Roles',
			modules: 'Modules',
			agents: 'Agents',
			workflows: 'Workflows',
			sandbox: 'Sandbox',
		},
		newTag: 'new',
		dashboard: {
			title: 'Dashboard',
			eyebrow: 'Operations Demo',
			parties: 'Parties',
			items: 'Catalog items',
			expenses: 'Open expenses',
			runs: 'Agent runs today',
			activity: 'Recent activity',
		},
		orders: {
			title: 'Orders',
			eyebrow: 'Operations Demo · sales.orders',
			action: 'New order',
			open: 'Open orders',
			approval: 'Awaiting approval',
			month: 'This month',
			colOrder: 'Order',
			colCustomer: 'Customer',
			colStatus: 'Status',
			colTotal: 'Total',
			draft: 'Draft',
			pending: 'Pending approval',
			approved: 'Approved',
		},
		enabled: 'Module enabled, scopes granted, no rebuild',
	},
	facts: {
		label: 'Coreloom at a glance',
		license: { value: 'MIT', label: 'Core license' },
		modules: { value: '11', label: 'Foundation modules' },
		gates: { value: '6', label: 'Delivery gates' },
		skills: { value: '14', label: 'Agent skills' },
		stack: { value: 'TypeScript', label: 'End to end, server to screen' },
	},
	how: {
		kicker: 'How a change ships',
		title: 'From a business brief to a pull request, with every step checked.',
		description:
			'The sandbox ties design and implementation to an approved specification. One session, one preview, one delivery, whether the change touches one module or five.',
		steps: {
			brief: {
				title: 'Brief',
				text: 'Describe the outcome in business language. A planner routes it to business, UX, backend, frontend and agentic specialists.',
			},
			spec: {
				title: 'Spec',
				text: 'Review the proposed specification or spec delta. Nothing is written until you approve its exact hash.',
			},
			gates: {
				title: 'Gates',
				text: 'Specialists implement the modules while deterministic gates check schema, dependencies, types, tests and format.',
			},
			preview: {
				title: 'Preview',
				text: 'Open the change inside the real application shell, with your data model and your permissions.',
			},
			deliver: {
				title: 'Deliver',
				text: 'Eject into modules/ and enable it, or open a pull request with the gate evidence attached.',
			},
		},
		stage: {
			brief: {
				user: 'We need customer orders with an approval step above 10 000.',
				planner: 'Planner routed the brief to',
				chips: ['Business', 'UX', 'Backend', 'Frontend', 'Agentic'],
			},
			spec: {
				file: 'modules/sales-orders/spec/module.yaml',
				hash: 'hash 3f9a2c',
				approve: 'Approve spec',
			},
			gates: {
				title: 'Gates for sales.orders',
				passed: '6 of 6 passed',
			},
			preview: {
				title: 'Orders',
				badge: 'Sandbox preview',
				note: 'Rendered inside the real shell, with real permissions',
			},
			deliver: {
				title: 'feat(sales.orders): orders with approval',
				branch: 'sandbox/orders-approval into main',
				checks: 'Gates passed · Ready for review',
				eject: 'Eject locally',
				pr: 'Open pull request',
			},
		},
	},
	sandbox: {
		kicker: 'Sandbox',
		title: 'The workshop where features get built.',
		description:
			'A separate application that turns a business brief into a reviewed module. It drives the coding agent your team already uses, in an isolated workspace, against the same gates the platform runs.',
		slides: [
			{
				label: 'Request',
				title: 'A brief starts a session',
				text: 'Describe the module or the change in business language and pick the coding agent. The planner names the modules and the first specialist.',
				alt: 'Coreloom sandbox: the brief box above three delivered sessions',
			},
			{
				label: 'Build',
				title: 'Specialists work behind the gates',
				text: 'Every turn ends with the six gates and the complete diff, file by file, before anything leaves the session workspace.',
				alt: 'Coreloom sandbox: passing gates beside the diff of a new module',
			},
			{
				label: 'Preview',
				title: 'The draft screen, running',
				text: 'The preview renders the module inside the real application shell, on its own ephemeral database, with real permissions and no access to your data.',
				alt: 'Coreloom sandbox: the preview tab showing the draft expense claims screen inside the application shell',
			},
			{
				label: 'Deliver',
				title: 'Ejected into the platform',
				text: 'Delivery writes the module into modules/ and enables it, or opens a pull request. The module catalog shows it with its permissions.',
				alt: 'Coreloom platform: the module catalog with the new module enabled',
			},
			{
				label: 'Live',
				title: 'Running in the real application',
				text: 'The screen the session built, in the workspace, with its own data, permissions and audit trail.',
				alt: 'Coreloom platform: the expense claims screen the sandbox session built',
			},
		],
		features: [
			{
				title: 'Your coding agent',
				text: 'Claude Code or Codex CLI on your machine, or the bundled simulation that calls nothing.',
			},
			{
				title: 'Isolated workspace',
				text: 'Each session gets a real pnpm workspace linked to the platform packages, never your repository.',
			},
			{
				title: 'Reviewed delivery',
				text: 'Six gates and a live preview every turn, then eject into modules/ or open a pull request.',
			},
		],
	},
	platform: {
		kicker: 'The platform beneath your product',
		title: 'A working foundation, not another starter kit.',
		description:
			'Coreloom owns the shared concerns every business platform needs, so each capability you add stays a small, explicit module that people and agents can read, test and replace.',
		accounts: {
			title: 'Accounts and workspaces',
			text: 'Multi-tenant from the first request: a sign-up wizard, workspace slugs in the URL, memberships, invitations and external sign-in providers.',
			rows: ['Operations Demo', 'Finance Demo', 'Northwind Trading'],
			active: 'active',
		},
		permissions: {
			title: 'Permissions and audit',
			text: 'Roles built from module.entity.action scopes, API tokens, per-module settings and an append-only audit trail. Every endpoint declares its permission.',
		},
		composition: {
			title: 'Module composition',
			text: 'Enable a module with one command. The CLI writes the composition, installs the package, grants scopes, and the running app reloads without a rebuild.',
		},
		agents: {
			title: 'Agent runtime',
			text: 'Reusable agents run against registered tools with leases, recovery, idempotency and durable run history. Tools reach data only through approved endpoints.',
		},
		workflows: {
			title: 'Workflows',
			text: 'Typed pipelines on a visual canvas: agent, action, validator, gate, input and output nodes, with dry runs and run history.',
		},
		admin: {
			title: 'Administration',
			text: 'Users, roles, modules, settings and audit in one place. Module settings live in the module drawer. Two locales out of the box.',
			rows: ['Allow sign-up', 'Email confirmation', 'Audit retention'],
		},
		cli: {
			title: 'Operator CLI',
			text: 'Dry run by default, --apply to write, --json for machines. Modules add their own namespaced commands with declared risk and approval.',
		},
	},
	modules: {
		kicker: 'The module contract',
		title: 'Every module owns its API, data, screens, translations and tests.',
		description:
			'A module is a package with a spec. The scaffold derives endpoints, permissions, migrations and client entry points from it, and validation keeps them in sync for as long as the module lives.',
		treeTitle: 'modules/catalog',
		codeTitle: 'src/api/endpoints.ts',
		points: [
			'An approved spec/module.yaml is the source of intent.',
			'Permissions are declared once and enforced on every route.',
			'Every query is tenant-scoped and every mutation checks the session.',
			'Translations ship per module and are validated for key drift.',
		],
		marqueeLabel: 'Foundation modules shipped in the repository',
	},
	agents: {
		kicker: 'Agents and workflows',
		title: 'Connect agents, decisions and business actions.',
		description:
			'Build typed pipelines on the canvas, validate data, branch on pass or fail, inspect a dry run and invoke the published workflow from any module that declares the dependency.',
		canvas: {
			title: 'Customer onboarding',
			dryRun: 'Dry run',
			nodes: {
				input: 'Input',
				agent: 'Agent',
				validator: 'Validator',
				gate: 'Gate',
				action: 'Action',
				output: 'Output',
			},
			trace: 'Flow trace',
			history: 'Run history kept',
		},
		skills: {
			title: 'The same guardrails in your editor',
			text: 'Fourteen skills in .ai/skills load into your coding agent, and AGENTS.md carries the contract, so the rules are the same in the sandbox and in your terminal.',
		},
	},
	openSource: {
		kicker: 'Open source',
		title: 'Built in the open. Owned by you.',
		description:
			'Coreloom is developed publicly on GitHub. The core is MIT licensed, the roadmap lives in issues, and a change lands only through the same gates the sandbox runs.',
		repo: {
			name: 'moxxy-ai/coreloom',
			tagline: 'The agentic foundation framework for OctaneJS',
			star: 'Star',
			fork: 'Fork',
			issues: 'Issues',
		},
		points: [
			'MIT licensed core with no seat limits.',
			'Self-host with the included Docker Compose and Kubernetes manifests.',
			'CI verifies types, tests, specs, formatting, the build and the container.',
			'Contribute a module or a fix through a pull request with gate evidence.',
		],
	},
	licensing: {
		kicker: 'Licensing',
		title: 'MIT core. Enterprise when you need it.',
		description:
			'Use the foundation freely, in any company, forever. Add an enterprise agreement when your organization needs support, guarantees and integrations.',
		core: {
			name: 'Core',
			license: 'MIT license',
			price: 'Free forever',
			text: 'The complete foundation in the repository.',
			points: [
				'Platform core, foundation modules, CLI and sandbox',
				'Commercial use, modification and redistribution',
				'Self-host on your own infrastructure',
				'Community support on GitHub',
			],
			cta: 'Source and license on GitHub',
		},
		enterprise: {
			name: 'Enterprise',
			license: 'Commercial license',
			price: 'Per organization',
			text: 'For companies running Coreloom in production at scale.',
			points: [
				'Commercial terms with warranty and indemnification',
				'Priority support and fixes with an SLA',
				'Guided deployment, upgrades and module reviews',
				'Enterprise integrations: SSO, SCIM, audit export',
			],
			cta: 'Contact us',
		},
	},
	faq: {
		title: 'Common questions',
		items: [
			{
				q: 'Can we use Coreloom commercially without paying?',
				a: 'Yes. The core is MIT licensed. Build and sell products on it, modify it and keep your changes private.',
			},
			{
				q: 'What does the enterprise license add?',
				a: 'Commercial terms, support with response times, help with deployment and upgrades, and the integrations larger organizations require. The code you run stays the same core.',
			},
			{
				q: 'Which AI models do the agents use?',
				a: 'Agents run through model providers configured per workspace. The default local provider simulates runs without calling any external service, so you can start offline.',
			},
			{
				q: 'Do we own the modules the sandbox builds?',
				a: 'Yes. A module is ordinary code in your repository, delivered as files or as a pull request. There is no runtime dependency on a hosted service.',
			},
		],
	},
	cta: {
		kicker: 'Start here',
		title: 'Keep the foundation. Shape everything above it.',
		description:
			'Run the platform locally in a few minutes, or create a workspace and describe your first module.',
		local: {
			title: 'Run it locally',
			note: 'Node.js 22.22 or newer and pnpm 11.',
		},
		hosted: {
			title: 'Create a workspace',
			text: 'Sign up, choose your modules and invite your team.',
			action: 'Create workspace',
			signIn: 'Sign in to an existing workspace',
		},
	},
	footer: {
		tagline: 'The agentic foundation for modular business platforms.',
		product: 'Product',
		openSource: 'Open source',
		resources: 'Resources',
		licensing: 'Licensing',
		links: {
			repository: 'Repository',
			issues: 'Issues',
			releases: 'Releases',
			contract: 'Contributor contract',
			readme: 'README',
			architecture: 'Architecture blueprint',
			designSystem: 'Design system',
			cli: 'CLI extensions',
			mit: 'MIT core license',
			enterprise: 'Enterprise license',
		},
		copyright: '© 2026 Coreloom. MIT licensed core.',
		built: 'Built with OctaneJS',
	},
};

export type LandingCopy = typeof en;

const pl: LandingCopy = {
	seo: {
		title: 'Otwarty framework agentycznego fundamentu dla platform biznesowych',
		description:
			'Coreloom dostarcza produkcyjny rdzeń: konta, przestrzenie robocze, uprawnienia, kompozycję modułów, runtime agentów, workflow, CLI i sandbox oparty na specyfikacjach. Rdzeń na licencji MIT, dostępna licencja enterprise.',
		imageAlt: 'Coreloom, framework agentycznego fundamentu',
	},
	nav: {
		home: 'Coreloom, strona główna',
		label: 'Nawigacja strony głównej',
		platform: 'Platforma',
		how: 'Jak to działa',
		sandbox: 'Sandbox',
		modules: 'Moduły',
		agents: 'Agenci',
		openSource: 'Open source',
		licensing: 'Licencje',
		product: 'Produkt',
		productMenu: 'Sekcje produktu',
		platformHint: 'Konta, uprawnienia, kompozycja, agenci',
		modulesHint: 'Kontrakt, który spełnia każdy moduł',
		agentsHint: 'Runtime agentów i kanwa workflow',
		openSourceHint: 'Rdzeń MIT, publiczne repozytorium',
		github: 'Coreloom na GitHubie',
		language: 'Język',
		menu: 'Menu',
		signIn: 'Zaloguj się',
		create: 'Utwórz przestrzeń',
	},
	hero: {
		badge: 'Open source · rdzeń MIT',
		kicker: 'Framework agentycznego fundamentu',
		title: 'Rdzeń Twojej platformy',
		titleAccent: 'jest już gotowy.',
		description:
			'Otwarty fundament modułowego oprogramowania biznesowego. Konta, uprawnienia, kompozycja modułów, agenci i workflow już działają, więc Twój zespół dostarcza moduły, a nie infrastrukturę.',
		primary: 'Utwórz swoją przestrzeń',
		secondary: 'Zobacz na GitHubie',
		note: 'Rdzeń na licencji MIT. Hostuj gdzie chcesz. Licencja enterprise dostępna.',
		cloneLabel: 'Sklonuj repozytorium',
		copy: 'Kopiuj',
		copied: 'Skopiowano',
	},
	demo: {
		label: 'Przestrzeń Coreloom podczas włączania nowego modułu z CLI',
		terminal: 'Terminal',
		groups: {
			workspace: 'Przestrzeń',
			operations: 'Operacje',
			administration: 'Administracja',
			development: 'Rozwój',
		},
		nav: {
			dashboard: 'Pulpit',
			parties: 'Kontrahenci',
			catalog: 'Katalog',
			expenses: 'Wydatki',
			orders: 'Zamówienia',
			users: 'Użytkownicy',
			roles: 'Role',
			modules: 'Moduły',
			agents: 'Agenci',
			workflows: 'Workflow',
			sandbox: 'Sandbox',
		},
		newTag: 'nowy',
		dashboard: {
			title: 'Pulpit',
			eyebrow: 'Operations Demo',
			parties: 'Kontrahenci',
			items: 'Pozycje katalogu',
			expenses: 'Otwarte wydatki',
			runs: 'Uruchomienia agentów dziś',
			activity: 'Ostatnia aktywność',
		},
		orders: {
			title: 'Zamówienia',
			eyebrow: 'Operations Demo · sales.orders',
			action: 'Nowe zamówienie',
			open: 'Otwarte zamówienia',
			approval: 'Czekają na akceptację',
			month: 'W tym miesiącu',
			colOrder: 'Zamówienie',
			colCustomer: 'Klient',
			colStatus: 'Status',
			colTotal: 'Wartość',
			draft: 'Szkic',
			pending: 'Do akceptacji',
			approved: 'Zaakceptowane',
		},
		enabled: 'Moduł włączony, uprawnienia nadane, bez przebudowy',
	},
	facts: {
		label: 'Coreloom w skrócie',
		license: { value: 'MIT', label: 'Licencja rdzenia' },
		modules: { value: '11', label: 'Modułów fundamentu' },
		gates: { value: '6', label: 'Bramek dostarczania' },
		skills: { value: '14', label: 'Skilli dla agentów' },
		stack: { value: 'TypeScript', label: 'Od serwera po ekran' },
	},
	how: {
		kicker: 'Jak powstaje zmiana',
		title:
			'Od potrzeby biznesowej do pull requesta, z kontrolą na każdym kroku.',
		description:
			'Sandbox wiąże projekt i implementację z zatwierdzoną specyfikacją. Jedna sesja, jeden podgląd, jedno dostarczenie, niezależnie od tego, czy zmiana dotyczy jednego modułu czy pięciu.',
		steps: {
			brief: {
				title: 'Brief',
				text: 'Opisz wynik językiem biznesowym. Planer kieruje go do specjalistów: biznesowego, UX, backendu, frontendu i agentowego.',
			},
			spec: {
				title: 'Specyfikacja',
				text: 'Przejrzyj proponowaną specyfikację lub jej zmianę. Nic nie powstaje, dopóki nie zatwierdzisz jej dokładnego hasha.',
			},
			gates: {
				title: 'Bramki',
				text: 'Specjaliści implementują moduły, a deterministyczne bramki sprawdzają schemat, zależności, typy, testy i format.',
			},
			preview: {
				title: 'Podgląd',
				text: 'Otwórz zmianę w prawdziwej powłoce aplikacji, na Twoim modelu danych i Twoich uprawnieniach.',
			},
			deliver: {
				title: 'Dostarczenie',
				text: 'Wyeksportuj do katalogu modules/ i włącz, albo otwórz pull request z dowodami z bramek.',
			},
		},
		stage: {
			brief: {
				user: 'Potrzebujemy zamówień klientów z akceptacją powyżej 10 000.',
				planner: 'Planer skierował brief do',
				chips: ['Biznes', 'UX', 'Backend', 'Frontend', 'Agentowy'],
			},
			spec: {
				file: 'modules/sales-orders/spec/module.yaml',
				hash: 'hash 3f9a2c',
				approve: 'Zatwierdź specyfikację',
			},
			gates: {
				title: 'Bramki dla sales.orders',
				passed: '6 z 6 zaliczonych',
			},
			preview: {
				title: 'Zamówienia',
				badge: 'Podgląd z sandboxa',
				note: 'Renderowane w prawdziwej powłoce, z prawdziwymi uprawnieniami',
			},
			deliver: {
				title: 'feat(sales.orders): zamówienia z akceptacją',
				branch: 'sandbox/orders-approval do main',
				checks: 'Bramki zaliczone · Gotowe do przeglądu',
				eject: 'Wyeksportuj lokalnie',
				pr: 'Otwórz pull request',
			},
		},
	},
	sandbox: {
		kicker: 'Sandbox',
		title: 'Warsztat, w którym powstają funkcje.',
		description:
			'Osobna aplikacja, która zamienia brief biznesowy w sprawdzony moduł. Steruje agentem kodującym, którego Twój zespół już używa, w izolowanej przestrzeni i według tych samych bramek, które uruchamia platforma.',
		slides: [
			{
				label: 'Zgłoszenie',
				title: 'Brief uruchamia sesję',
				text: 'Opisz moduł albo zmianę językiem biznesowym i wybierz agenta kodującego. Planer wskazuje moduły i pierwszego specjalistę.',
				alt: 'Coreloom sandbox: pole briefu nad trzema dostarczonymi sesjami',
			},
			{
				label: 'Budowa',
				title: 'Specjaliści pracują za bramkami',
				text: 'Każda tura kończy się sześcioma bramkami i kompletnym diffem, plik po pliku, zanim cokolwiek opuści przestrzeń sesji.',
				alt: 'Coreloom sandbox: zaliczone bramki obok diffa nowego modułu',
			},
			{
				label: 'Podgląd',
				title: 'Projekt ekranu w działaniu',
				text: 'Podgląd renderuje moduł w prawdziwej powłoce aplikacji, na własnej efemerycznej bazie, z prawdziwymi uprawnieniami i bez dostępu do Twoich danych.',
				alt: 'Sandbox Coreloom: zakładka podglądu z projektem ekranu wydatków w powłoce aplikacji',
			},
			{
				label: 'Dostarczenie',
				title: 'Eksport do platformy',
				text: 'Dostarczenie zapisuje moduł w modules/ i włącza go albo otwiera pull request. Katalog modułów pokazuje go razem z uprawnieniami.',
				alt: 'Platforma Coreloom: katalog modułów z włączonym nowym modułem',
			},
			{
				label: 'Na żywo',
				title: 'Działa w prawdziwej aplikacji',
				text: 'Ekran zbudowany w sesji, w przestrzeni roboczej, z własnymi danymi, uprawnieniami i audytem.',
				alt: 'Platforma Coreloom: ekran wydatków zbudowany w sesji sandboxa',
			},
		],
		features: [
			{
				title: 'Twój agent kodujący',
				text: 'Claude Code albo Codex CLI na Twojej maszynie, albo dołączona symulacja, która niczego nie wywołuje.',
			},
			{
				title: 'Izolowana przestrzeń',
				text: 'Każda sesja dostaje prawdziwy workspace pnpm podlinkowany do pakietów platformy, nigdy Twoje repozytorium.',
			},
			{
				title: 'Sprawdzone dostarczenie',
				text: 'Sześć bramek i podgląd na żywo w każdej turze, potem eksport do modules/ albo pull request.',
			},
		],
	},
	platform: {
		kicker: 'Platforma pod Twoim produktem',
		title: 'Działający fundament, nie kolejny szablon startowy.',
		description:
			'Coreloom przejmuje wspólne elementy, których potrzebuje każda platforma biznesowa. Każda funkcja, którą dodajesz, pozostaje małym, jawnym modułem, który ludzie i agenci mogą przeczytać, przetestować i wymienić.',
		accounts: {
			title: 'Konta i przestrzenie',
			text: 'Wielodostępność od pierwszego żądania: kreator rejestracji, slug przestrzeni w adresie, członkostwa, zaproszenia i zewnętrzni dostawcy logowania.',
			rows: ['Operations Demo', 'Finance Demo', 'Northwind Trading'],
			active: 'aktywna',
		},
		permissions: {
			title: 'Uprawnienia i audyt',
			text: 'Role zbudowane ze scope’ów moduł.encja.akcja, tokeny API, ustawienia per moduł i dopisywany audyt. Każdy endpoint deklaruje swoje uprawnienie.',
		},
		composition: {
			title: 'Kompozycja modułów',
			text: 'Włączasz moduł jedną komendą. CLI zapisuje kompozycję, instaluje pakiet, nadaje uprawnienia, a działająca aplikacja przeładowuje się bez przebudowy.',
		},
		agents: {
			title: 'Runtime agentów',
			text: 'Wielokrotnego użytku agenci działają na zarejestrowanych narzędziach z dzierżawami, odzyskiwaniem, idempotencją i trwałą historią uruchomień. Narzędzia sięgają do danych tylko przez zatwierdzone endpointy.',
		},
		workflows: {
			title: 'Workflow',
			text: 'Typowane pipeline’y na wizualnym obszarze roboczym: węzły agenta, akcji, walidatora, bramki, wejścia i wyjścia, z trybem testowym i historią uruchomień.',
		},
		admin: {
			title: 'Administracja',
			text: 'Użytkownicy, role, moduły, ustawienia i audyt w jednym miejscu. Ustawienia modułu żyją w jego panelu. Dwa języki od razu.',
			rows: ['Rejestracja otwarta', 'Potwierdzenie e-mail', 'Retencja audytu'],
		},
		cli: {
			title: 'CLI operatora',
			text: 'Domyślnie dry run, --apply zapisuje, --json dla maszyn. Moduły dodają własne komendy w przestrzeni nazw z zadeklarowanym ryzykiem i akceptacją.',
		},
	},
	modules: {
		kicker: 'Kontrakt modułu',
		title: 'Każdy moduł posiada własne API, dane, ekrany, tłumaczenia i testy.',
		description:
			'Moduł to pakiet ze specyfikacją. Scaffold wyprowadza z niej endpointy, uprawnienia, migracje i punkty wejścia klienta, a walidacja pilnuje spójności przez całe życie modułu.',
		treeTitle: 'modules/catalog',
		codeTitle: 'src/api/endpoints.ts',
		points: [
			'Zatwierdzony spec/module.yaml jest źródłem intencji.',
			'Uprawnienia deklarujesz raz, a egzekwowane są na każdej trasie.',
			'Każde zapytanie jest ograniczone do tenanta, a każda mutacja sprawdza sesję.',
			'Tłumaczenia są częścią modułu i są walidowane pod kątem rozjazdu kluczy.',
		],
		marqueeLabel: 'Moduły fundamentu dostarczane w repozytorium',
	},
	agents: {
		kicker: 'Agenci i workflow',
		title: 'Łącz agentów, decyzje i działania biznesowe.',
		description:
			'Buduj typowane pipeline’y na kanwie, waliduj dane, rozgałęziaj przebieg, sprawdzaj tryb testowy i wywołuj opublikowany workflow z każdego modułu, który deklaruje zależność.',
		canvas: {
			title: 'Wdrożenie klienta',
			dryRun: 'Tryb testowy',
			nodes: {
				input: 'Wejście',
				agent: 'Agent',
				validator: 'Walidator',
				gate: 'Bramka',
				action: 'Akcja',
				output: 'Wyjście',
			},
			trace: 'Ślad przepływu',
			history: 'Historia uruchomień zachowana',
		},
		skills: {
			title: 'Te same reguły w Twoim edytorze',
			text: 'Czternaście skilli z .ai/skills ładuje się do Twojego agenta kodującego, a AGENTS.md niesie kontrakt, więc zasady są te same w sandboxie i w terminalu.',
		},
	},
	openSource: {
		kicker: 'Open source',
		title: 'Rozwijany jawnie. Należy do Ciebie.',
		description:
			'Coreloom powstaje publicznie na GitHubie. Rdzeń jest na licencji MIT, roadmapa żyje w issues, a zmiana ląduje tylko przez te same bramki, które uruchamia sandbox.',
		repo: {
			name: 'moxxy-ai/coreloom',
			tagline: 'Framework agentycznego fundamentu dla OctaneJS',
			star: 'Gwiazdka',
			fork: 'Fork',
			issues: 'Issues',
		},
		points: [
			'Rdzeń na licencji MIT bez limitu użytkowników.',
			'Hostuj samodzielnie z dołączonym Docker Compose i manifestami Kubernetes.',
			'CI sprawdza typy, testy, specyfikacje, format, build i kontener.',
			'Dołóż moduł lub poprawkę przez pull request z dowodami z bramek.',
		],
	},
	licensing: {
		kicker: 'Licencje',
		title: 'Rdzeń MIT. Enterprise, gdy go potrzebujesz.',
		description:
			'Korzystaj z fundamentu bez ograniczeń, w każdej firmie, na zawsze. Dołóż umowę enterprise, gdy Twoja organizacja potrzebuje wsparcia, gwarancji i integracji.',
		core: {
			name: 'Core',
			license: 'Licencja MIT',
			price: 'Za darmo, na zawsze',
			text: 'Kompletny fundament dostępny w repozytorium.',
			points: [
				'Rdzeń platformy, moduły fundamentu, CLI i sandbox',
				'Użycie komercyjne, modyfikacja i redystrybucja',
				'Hosting na własnej infrastrukturze',
				'Wsparcie społeczności na GitHubie',
			],
			cta: 'Źródła i licencja na GitHubie',
		},
		enterprise: {
			name: 'Enterprise',
			license: 'Licencja komercyjna',
			price: 'Na organizację',
			text: 'Dla firm, które uruchamiają Coreloom produkcyjnie na dużą skalę.',
			points: [
				'Warunki komercyjne z gwarancją i ochroną prawną',
				'Priorytetowe wsparcie i poprawki z SLA',
				'Wdrożenie, aktualizacje i przeglądy modułów z przewodnikiem',
				'Integracje enterprise: SSO, SCIM, eksport audytu',
			],
			cta: 'Skontaktuj się',
		},
	},
	faq: {
		title: 'Częste pytania',
		items: [
			{
				q: 'Czy możemy używać Coreloom komercyjnie bez opłat?',
				a: 'Tak. Rdzeń jest na licencji MIT. Buduj i sprzedawaj produkty na jego bazie, modyfikuj go i zachowaj swoje zmiany dla siebie.',
			},
			{
				q: 'Co dodaje licencja enterprise?',
				a: 'Warunki komercyjne, wsparcie z czasami reakcji, pomoc przy wdrożeniu i aktualizacjach oraz integracje wymagane w większych organizacjach. Uruchamiany kod pozostaje tym samym rdzeniem.',
			},
			{
				q: 'Z jakich modeli AI korzystają agenci?',
				a: 'Agenci działają przez dostawców modeli konfigurowanych per przestrzeń. Domyślny lokalny dostawca symuluje uruchomienia bez wywoływania zewnętrznych usług, więc możesz zacząć offline.',
			},
			{
				q: 'Czy moduły zbudowane w sandboxie należą do nas?',
				a: 'Tak. Moduł to zwykły kod w Twoim repozytorium, dostarczony jako pliki albo pull request. Nie ma zależności od żadnej hostowanej usługi w czasie działania.',
			},
		],
	},
	cta: {
		kicker: 'Zacznij tutaj',
		title: 'Zachowaj fundament. Nadaj kształt całej reszcie.',
		description:
			'Uruchom platformę lokalnie w kilka minut albo utwórz przestrzeń i opisz swój pierwszy moduł.',
		local: {
			title: 'Uruchom lokalnie',
			note: 'Node.js 22.22 lub nowszy i pnpm 11.',
		},
		hosted: {
			title: 'Utwórz przestrzeń',
			text: 'Zarejestruj się, wybierz moduły i zaproś zespół.',
			action: 'Utwórz przestrzeń',
			signIn: 'Zaloguj się do istniejącej przestrzeni',
		},
	},
	footer: {
		tagline: 'Agentyczny fundament modułowych platform biznesowych.',
		product: 'Produkt',
		openSource: 'Open source',
		resources: 'Materiały',
		licensing: 'Licencje',
		links: {
			repository: 'Repozytorium',
			issues: 'Issues',
			releases: 'Wydania',
			contract: 'Kontrakt dla kontrybutorów',
			readme: 'README',
			architecture: 'Blueprint architektury',
			designSystem: 'Design system',
			cli: 'Rozszerzenia CLI',
			mit: 'Licencja MIT rdzenia',
			enterprise: 'Licencja enterprise',
		},
		copyright: '© 2026 Coreloom. Rdzeń na licencji MIT.',
		built: 'Zbudowane na OctaneJS',
	},
};

const COPY: Readonly<Record<LandingLocale, LandingCopy>> = { en, pl };

export function landingCopy(locale: LandingLocale): LandingCopy {
	return COPY[locale];
}
