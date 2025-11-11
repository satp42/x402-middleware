/**
 * Facilitator Service
 * 
 * Manages payment authorizations for deferred x402 payments:
 * - Verify and store payment authorizations
 * - Track usage per agent/session
 * - Queue authorizations for batch settlement
 * - Provide audit logs and dispute mechanisms
 */

import type {
  PaymentAuthorization,
  SettlementBatch,
  DisputeRecord,
  SettlementThreshold
} from '@darkresearch/mallory-shared';
import { createHash } from 'crypto';

export interface AuthorizationStore {
  [authorizationId: string]: PaymentAuthorization;
}

export interface AgentUsageTracker {
  [agentAddress: string]: {
    authorizations: string[]; // authorization IDs
    totalAmount: number;
    firstRequestAt: number;
    lastRequestAt: number;
    requestCount: number;
  };
}

export class FacilitatorService {
  private authorizations: AuthorizationStore = {};
  private agentUsage: AgentUsageTracker = {};
  private settlementQueue: string[] = []; // Authorization IDs queued for settlement
  private settlementBatches: SettlementBatch[] = [];
  private disputes: DisputeRecord[] = [];
  private settlementThresholds: SettlementThreshold;

  constructor(config: {
    settlementThresholds: SettlementThreshold;
  }) {
    this.settlementThresholds = config.settlementThresholds;
  }

  /**
   * Verify and store a payment authorization
   */
  async verifyAuthorization(authorization: PaymentAuthorization): Promise<{
    valid: boolean;
    reason?: string;
  }> {
    console.log('🔍 [Facilitator] Verifying authorization:', authorization.id);

    // Check if authorization already exists
    if (this.authorizations[authorization.id]) {
      return { valid: false, reason: 'Authorization already exists' };
    }

    // Check expiration
    if (authorization.expiresAt < Date.now()) {
      return { valid: false, reason: 'Authorization expired' };
    }

    // Verify signature
    const isValid = this.verifySignature(authorization);
    if (!isValid) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // Merchant address is now dynamic from 402 response, no need to validate against config

    // Store authorization
    this.authorizations[authorization.id] = authorization;

    // Track agent usage
    this.trackAgentUsage(authorization);

    console.log('✅ [Facilitator] Authorization verified and stored');
    return { valid: true };
  }

  /**
   * Queue authorization for settlement
   */
  async queueForSettlement(authorizationId: string): Promise<{
    success: boolean;
    shouldSettle: boolean;
    reason?: string;
  }> {
    console.log('📥 [Facilitator] Queueing for settlement:', authorizationId);

    const authorization = this.authorizations[authorizationId];
    if (!authorization) {
      return { 
        success: false, 
        shouldSettle: false, 
        reason: 'Authorization not found' 
      };
    }

    // Check if already queued or settled
    if (this.settlementQueue.includes(authorizationId)) {
      return { 
        success: false, 
        shouldSettle: false, 
        reason: 'Already queued' 
      };
    }

    if (authorization.status === 'settled') {
      return { 
        success: false, 
        shouldSettle: false, 
        reason: 'Already settled' 
      };
    }

    // Add to queue
    this.settlementQueue.push(authorizationId);
    authorization.status = 'validated';

    console.log('✅ [Facilitator] Authorization queued');

    // Check if settlement thresholds are met
    const shouldSettle = this.checkSettlementThresholds(authorization.agentAddress);

    return { 
      success: true, 
      shouldSettle,
      reason: shouldSettle ? 'Settlement threshold met' : undefined
    };
  }

  /**
   * List pending authorizations for an agent
   */
  listPendingAuthorizations(agentAddress: string): PaymentAuthorization[] {
    return Object.values(this.authorizations).filter(
      auth => 
        auth.agentAddress === agentAddress && 
        auth.status === 'validated' &&
        this.settlementQueue.includes(auth.id)
    );
  }

  /**
   * Get authorization by ID
   */
  getAuthorization(authorizationId: string): PaymentAuthorization | undefined {
    return this.authorizations[authorizationId];
  }

  /**
   * List all authorizations for an agent
   */
  listAuthorizationsByAgent(agentAddress: string): PaymentAuthorization[] {
    return Object.values(this.authorizations).filter(
      auth => auth.agentAddress === agentAddress
    );
  }

  /**
   * Get agent usage statistics
   */
  getAgentUsage(agentAddress: string) {
    return this.agentUsage[agentAddress] || {
      authorizations: [],
      totalAmount: 0,
      firstRequestAt: 0,
      lastRequestAt: 0,
      requestCount: 0
    };
  }

  /**
   * Create settlement batch for an agent
   * Groups authorizations by merchant address since different tools may have different merchants
   */
  createSettlementBatch(agentAddress: string, merchantAddress?: string): SettlementBatch | null {
    console.log('📦 [Facilitator] Creating settlement batch for:', agentAddress);
    if (merchantAddress) {
      console.log('   Specific merchant:', merchantAddress);
    }

    // Get all queued authorizations for this agent
    let agentAuthorizations = this.settlementQueue
      .map(id => this.authorizations[id])
      .filter(auth => auth && auth.agentAddress === agentAddress);

    if (agentAuthorizations.length === 0) {
      console.log('⚠️ [Facilitator] No authorizations to settle');
      return null;
    }

    // Group by merchant address if not specified
    if (!merchantAddress) {
      // Find the merchant with most authorizations to settle
      const merchantCounts = new Map<string, number>();
      agentAuthorizations.forEach(auth => {
        const count = merchantCounts.get(auth.merchantAddress) || 0;
        merchantCounts.set(auth.merchantAddress, count + 1);
      });
      
      // Get merchant with most authorizations
      let maxCount = 0;
      merchantCounts.forEach((count, merchant) => {
        if (count > maxCount) {
          maxCount = count;
          merchantAddress = merchant;
        }
      });
    }

    // Filter to only include authorizations for this merchant
    agentAuthorizations = agentAuthorizations.filter(
      auth => auth.merchantAddress === merchantAddress
    );

    if (agentAuthorizations.length === 0) {
      console.log('⚠️ [Facilitator] No authorizations for merchant:', merchantAddress);
      return null;
    }

    // Calculate total amount
    const totalAmount = agentAuthorizations
      .reduce((sum, auth) => sum + parseFloat(auth.amount), 0)
      .toFixed(6);

    const batch: SettlementBatch = {
      id: `batch_${Date.now()}_${agentAddress.substring(0, 8)}`,
      agentAddress,
      merchantAddress: merchantAddress!,
      authorizations: agentAuthorizations,
      totalAmount,
      currency: agentAuthorizations[0].currency,
      status: 'pending',
      createdAt: Date.now()
    };

    this.settlementBatches.push(batch);

    console.log('✅ [Facilitator] Settlement batch created:', batch.id);
    console.log('   Merchant:', merchantAddress);
    console.log('   Authorizations:', agentAuthorizations.length);
    console.log('   Total amount:', totalAmount, batch.currency);

    return batch;
  }

  /**
   * Get all unique merchant addresses from pending authorizations
   */
  getPendingMerchants(agentAddress: string): string[] {
    const merchants = new Set<string>();
    
    this.settlementQueue.forEach(authId => {
      const auth = this.authorizations[authId];
      if (auth && auth.agentAddress === agentAddress) {
        merchants.add(auth.merchantAddress);
      }
    });
    
    return Array.from(merchants);
  }

  /**
   * Mark settlement batch as completed
   */
  async completeSettlement(
    batchId: string,
    transactionSignature: string
  ): Promise<void> {
    console.log('✅ [Facilitator] Completing settlement batch:', batchId);

    const batch = this.settlementBatches.find(b => b.id === batchId);
    if (!batch) {
      throw new Error('Settlement batch not found');
    }

    batch.status = 'completed';
    batch.settledAt = Date.now();
    batch.transactionSignature = transactionSignature;

    // Mark all authorizations as settled
    batch.authorizations.forEach(auth => {
      auth.status = 'settled';
      // Remove from queue
      const queueIndex = this.settlementQueue.indexOf(auth.id);
      if (queueIndex !== -1) {
        this.settlementQueue.splice(queueIndex, 1);
      }
    });

    console.log('✅ [Facilitator] Settlement completed');
    console.log('   Transaction:', transactionSignature);
  }

  /**
   * Mark settlement batch as failed
   */
  async failSettlement(batchId: string, error: string): Promise<void> {
    console.log('❌ [Facilitator] Settlement failed:', batchId);

    const batch = this.settlementBatches.find(b => b.id === batchId);
    if (!batch) {
      throw new Error('Settlement batch not found');
    }

    batch.status = 'failed';
    batch.error = error;

    // Return authorizations to pending status
    batch.authorizations.forEach(auth => {
      auth.status = 'pending';
    });
  }

  /**
   * Get settlement batches
   */
  getSettlementBatches(agentAddress?: string): SettlementBatch[] {
    if (agentAddress) {
      return this.settlementBatches.filter(b => b.agentAddress === agentAddress);
    }
    return this.settlementBatches;
  }

  /**
   * Create dispute record
   */
  async createDispute(params: {
    authorizationId: string;
    agentAddress: string;
    reason: string;
    evidence?: DisputeRecord['evidence'];
  }): Promise<DisputeRecord> {
    console.log('⚠️ [Facilitator] Creating dispute for:', params.authorizationId);

    const authorization = this.authorizations[params.authorizationId];
    if (!authorization) {
      throw new Error('Authorization not found');
    }

    if (authorization.agentAddress !== params.agentAddress) {
      throw new Error('Agent address mismatch');
    }

    const dispute: DisputeRecord = {
      id: `dispute_${Date.now()}_${params.authorizationId}`,
      authorizationId: params.authorizationId,
      agentAddress: params.agentAddress,
      merchantAddress: authorization.merchantAddress,
      reason: params.reason,
      status: 'pending',
      createdAt: Date.now(),
      evidence: params.evidence
    };

    this.disputes.push(dispute);

    // Mark authorization as disputed
    authorization.status = 'disputed';

    // Remove from settlement queue if present
    const queueIndex = this.settlementQueue.indexOf(params.authorizationId);
    if (queueIndex !== -1) {
      this.settlementQueue.splice(queueIndex, 1);
    }

    console.log('✅ [Facilitator] Dispute created:', dispute.id);
    return dispute;
  }

  /**
   * Resolve dispute
   */
  async resolveDispute(
    disputeId: string,
    resolution: 'approved' | 'rejected',
    resolutionNote?: string
  ): Promise<void> {
    console.log('⚖️ [Facilitator] Resolving dispute:', disputeId);

    const dispute = this.disputes.find(d => d.id === disputeId);
    if (!dispute) {
      throw new Error('Dispute not found');
    }

    dispute.status = 'resolved';
    dispute.resolvedAt = Date.now();
    dispute.resolution = resolutionNote;

    const authorization = this.authorizations[dispute.authorizationId];
    if (authorization) {
      if (resolution === 'rejected') {
        // Dispute rejected, proceed with settlement
        authorization.status = 'validated';
        this.settlementQueue.push(authorization.id);
      } else {
        // Dispute approved, cancel authorization
        authorization.status = 'disputed';
      }
    }

    console.log('✅ [Facilitator] Dispute resolved:', resolution);
  }

  /**
   * Get disputes
   */
  getDisputes(agentAddress?: string): DisputeRecord[] {
    if (agentAddress) {
      return this.disputes.filter(d => d.agentAddress === agentAddress);
    }
    return this.disputes;
  }

  /**
   * Clean up expired authorizations
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    Object.values(this.authorizations).forEach(auth => {
      if (auth.expiresAt < now && auth.status === 'pending') {
        auth.status = 'expired';
        
        // Remove from queue if present
        const queueIndex = this.settlementQueue.indexOf(auth.id);
        if (queueIndex !== -1) {
          this.settlementQueue.splice(queueIndex, 1);
        }
        
        cleaned++;
      }
    });

    if (cleaned > 0) {
      console.log(`🧹 [Facilitator] Cleaned up ${cleaned} expired authorizations`);
    }

    return cleaned;
  }

  // Private helper methods

  private trackAgentUsage(authorization: PaymentAuthorization): void {
    const agentAddress = authorization.agentAddress;
    
    if (!this.agentUsage[agentAddress]) {
      this.agentUsage[agentAddress] = {
        authorizations: [],
        totalAmount: 0,
        firstRequestAt: Date.now(),
        lastRequestAt: Date.now(),
        requestCount: 0
      };
    }

    const usage = this.agentUsage[agentAddress];
    usage.authorizations.push(authorization.id);
    usage.totalAmount += parseFloat(authorization.amount);
    usage.lastRequestAt = Date.now();
    usage.requestCount += 1;
  }

  private checkSettlementThresholds(agentAddress: string): boolean {
    const usage = this.agentUsage[agentAddress];
    if (!usage) return false;

    const queuedAuthorizations = this.settlementQueue
      .map(id => this.authorizations[id])
      .filter(auth => auth && auth.agentAddress === agentAddress);

    const queuedAmount = queuedAuthorizations
      .reduce((sum, auth) => sum + parseFloat(auth.amount), 0);

    const queuedCount = queuedAuthorizations.length;

    const timeSinceFirst = (Date.now() - usage.firstRequestAt) / 1000; // seconds

    // Check thresholds
    const amountThreshold = parseFloat(this.settlementThresholds.amountThreshold);
    const timeThreshold = this.settlementThresholds.timeThreshold;
    const countThreshold = this.settlementThresholds.countThreshold;

    const meetsAmount = queuedAmount >= amountThreshold;
    const meetsTime = timeSinceFirst >= timeThreshold;
    const meetsCount = queuedCount >= countThreshold;

    console.log('📊 [Facilitator] Settlement threshold check:', {
      agent: agentAddress.substring(0, 8),
      queuedAmount,
      queuedCount,
      timeSinceFirst,
      meetsAmount,
      meetsTime,
      meetsCount
    });

    return meetsAmount || meetsTime || meetsCount;
  }

  private verifySignature(authorization: PaymentAuthorization): boolean {
    // Recreate the signature payload
    const payload = [
      authorization.id,
      authorization.agentAddress,
      authorization.merchantAddress,
      authorization.amount,
      authorization.currency,
      authorization.timestamp,
      authorization.expiresAt,
      authorization.nonce
    ].join('|');

    // Verify signature
    const expectedSignature = createHash('sha256').update(payload).digest('hex');
    return expectedSignature === authorization.signature;
  }
}

