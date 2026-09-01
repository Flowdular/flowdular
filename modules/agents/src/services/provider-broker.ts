import type { AgentProvider } from '@coreloom/harness';
import type { AgentProviderService } from './provider-service.ts';
import type { AgentRepository } from './repository.ts';
import {
	AgentRunGrantAuthority,
	type AgentRunGrantClaims,
} from './run-grant.ts';

export class AgentProviderBrokerError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AgentProviderBrokerError';
	}
}

export interface ExchangedAgentProvider {
	readonly provider: AgentProvider | null;
	readonly claims: AgentRunGrantClaims;
}

export class AgentProviderBroker {
	readonly #now: () => number;

	constructor(
		private readonly grants: AgentRunGrantAuthority,
		private readonly repository: AgentRepository,
		private readonly providers: AgentProviderService,
		now: () => number = Date.now,
	) {
		this.#now = now;
	}

	async exchange(token: string): Promise<ExchangedAgentProvider> {
		const claims = this.grants.verify(token);
		const consumedAt = this.#now();
		const consumed = this.repository.consumeRunGrant({
			grantId: claims.grantId,
			tokenHash: this.grants.tokenHash(token),
			tenantId: claims.tenantId,
			runId: claims.runId,
			workerId: claims.workerId,
			providerId: claims.providerId,
			modelId: claims.modelId,
			issuedAt: claims.issuedAt,
			expiresAt: claims.expiresAt,
			consumedAt,
		});
		if (!consumed) {
			throw new AgentProviderBrokerError(
				'RUN_GRANT_REJECTED',
				'Run grant was already used or its worker lease is no longer valid.',
			);
		}
		this.repository.appendAuditEvent({
			tenantId: claims.tenantId,
			actorId: 'agent-provider-broker',
			action: 'agent-run.grant-consumed',
			subjectType: 'agent-run',
			subjectId: claims.runId,
			metadata: {
				grantId: claims.grantId,
				providerId: claims.providerId,
				modelId: claims.modelId,
				attempt: claims.attempt,
			},
			occurredAt: consumedAt,
		});
		return {
			provider: await this.providers.resolve(
				claims.tenantId,
				claims.providerId,
				claims.modelId,
			),
			claims,
		};
	}
}
