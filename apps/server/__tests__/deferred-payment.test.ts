/**
 * Deferred Payment Tests
 * 
 * Comprehensive tests for deferred payment flows:
 * - Authorization creation and verification
 * - Batch settlement
 * - Dispute handling
 * - Threshold triggering
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { FacilitatorService } from '../src/services/facilitator/FacilitatorService';
import type { PaymentAuthorization } from '@darkresearch/mallory-shared';

describe('Deferred Payment System', () => {
  let facilitator: FacilitatorService;
  const mockAgentAddress = 'mockAgent123';
  const mockMerchantAddress = 'mockMerchant456';

  beforeEach(() => {
    facilitator = new FacilitatorService({
      settlementThresholds: {
        amountThreshold: '1.00',
        timeThreshold: 3600, // 1 hour
        countThreshold: 100
      }
    });
  });

  describe('Authorization Management', () => {
    test('should verify and store valid authorization', async () => {
      const authorization: PaymentAuthorization = {
        id: 'auth_test_001',
        agentAddress: mockAgentAddress,
        merchantAddress: mockMerchantAddress,
        toolName: 'nansenHistoricalBalances',
        amount: '0.001',
        currency: 'USDC',
        timestamp: Date.now(),
        expiresAt: Date.now() + 3600000, // 1 hour
        nonce: 'test_nonce_123',
        signature: 'mock_signature',
        status: 'pending'
      };

      // Recalculate signature for test
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
      
      const crypto = require('crypto');
      authorization.signature = crypto.createHash('sha256').update(payload).digest('hex');

      const result = await facilitator.verifyAuthorization(authorization);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();

      const stored = facilitator.getAuthorization(authorization.id);
      expect(stored).toBeDefined();
      expect(stored?.id).toBe(authorization.id);
    });

    test('should reject expired authorization', async () => {
      const authorization: PaymentAuthorization = {
        id: 'auth_test_002',
        agentAddress: mockAgentAddress,
        merchantAddress: mockMerchantAddress,
        toolName: 'nansenHistoricalBalances',
        amount: '0.001',
        currency: 'USDC',
        timestamp: Date.now() - 7200000, // 2 hours ago
        expiresAt: Date.now() - 3600000, // 1 hour ago (expired)
        nonce: 'test_nonce_456',
        signature: 'mock_signature',
        status: 'pending'
      };

      const result = await facilitator.verifyAuthorization(authorization);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Authorization expired');
    });

    test('should reject invalid signature', async () => {
      const authorization: PaymentAuthorization = {
        id: 'auth_test_003',
        agentAddress: mockAgentAddress,
        merchantAddress: mockMerchantAddress,
        toolName: 'nansenHistoricalBalances',
        amount: '0.001',
        currency: 'USDC',
        timestamp: Date.now(),
        expiresAt: Date.now() + 3600000,
        nonce: 'test_nonce_789',
        signature: 'invalid_signature',
        status: 'pending'
      };

      const result = await facilitator.verifyAuthorization(authorization);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });
  });

  describe('Settlement Queueing', () => {
    test('should queue authorization for settlement', async () => {
      // First, create and verify an authorization
      const authorization = await createValidAuthorization(facilitator, {
        id: 'auth_queue_001',
        agentAddress: mockAgentAddress,
        amount: '0.001'
      });

      const result = await facilitator.queueForSettlement(authorization.id);

      expect(result.success).toBe(true);
      
      const pending = facilitator.listPendingAuthorizations(mockAgentAddress);
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(authorization.id);
    });

    test('should detect settlement threshold (amount)', async () => {
      // Create multiple authorizations totaling >= 1.00 USDC
      await createValidAuthorization(facilitator, {
        id: 'auth_threshold_001',
        agentAddress: mockAgentAddress,
        amount: '0.6'
      });

      await createValidAuthorization(facilitator, {
        id: 'auth_threshold_002',
        agentAddress: mockAgentAddress,
        amount: '0.5'
      });

      // Queue both
      await facilitator.queueForSettlement('auth_threshold_001');
      const result = await facilitator.queueForSettlement('auth_threshold_002');

      expect(result.shouldSettle).toBe(true);
      expect(result.reason).toBe('Settlement threshold met');
    });
  });

  describe('Batch Settlement', () => {
    test('should create settlement batch', async () => {
      // Create and queue multiple authorizations
      await createValidAuthorization(facilitator, {
        id: 'auth_batch_001',
        agentAddress: mockAgentAddress,
        amount: '0.3'
      });

      await createValidAuthorization(facilitator, {
        id: 'auth_batch_002',
        agentAddress: mockAgentAddress,
        amount: '0.4'
      });

      await facilitator.queueForSettlement('auth_batch_001');
      await facilitator.queueForSettlement('auth_batch_002');

      const batch = facilitator.createSettlementBatch(mockAgentAddress);

      expect(batch).toBeDefined();
      expect(batch?.authorizations.length).toBe(2);
      expect(batch?.totalAmount).toBe('0.700000');
      expect(batch?.status).toBe('pending');
    });

    test('should complete settlement batch', async () => {
      await createValidAuthorization(facilitator, {
        id: 'auth_complete_001',
        agentAddress: mockAgentAddress,
        amount: '0.5'
      });

      await facilitator.queueForSettlement('auth_complete_001');
      const batch = facilitator.createSettlementBatch(mockAgentAddress);

      if (!batch) {
        throw new Error('Failed to create batch');
      }

      const mockSignature = 'mock_tx_signature_12345';
      await facilitator.completeSettlement(batch.id, mockSignature);

      const batches = facilitator.getSettlementBatches(mockAgentAddress);
      const completedBatch = batches.find(b => b.id === batch.id);

      expect(completedBatch?.status).toBe('completed');
      expect(completedBatch?.transactionSignature).toBe(mockSignature);
      expect(completedBatch?.settledAt).toBeDefined();
    });
  });

  describe('Dispute Resolution', () => {
    test('should create dispute for authorization', async () => {
      const authorization = await createValidAuthorization(facilitator, {
        id: 'auth_dispute_001',
        agentAddress: mockAgentAddress,
        amount: '0.001'
      });

      const dispute = await facilitator.createDispute({
        authorizationId: authorization.id,
        agentAddress: mockAgentAddress,
        reason: 'Data quality issue',
        evidence: {
          validationErrors: ['Empty response', 'Invalid format']
        }
      });

      expect(dispute.id).toContain('dispute_');
      expect(dispute.status).toBe('pending');
      expect(dispute.reason).toBe('Data quality issue');

      // Authorization should be marked as disputed
      const auth = facilitator.getAuthorization(authorization.id);
      expect(auth?.status).toBe('disputed');
    });

    test('should resolve dispute with rejection', async () => {
      const authorization = await createValidAuthorization(facilitator, {
        id: 'auth_resolve_001',
        agentAddress: mockAgentAddress,
        amount: '0.001'
      });

      const dispute = await facilitator.createDispute({
        authorizationId: authorization.id,
        agentAddress: mockAgentAddress,
        reason: 'Test dispute'
      });

      // Reject dispute (proceed with settlement)
      await facilitator.resolveDispute(dispute.id, 'rejected', 'Data was valid');

      const disputes = facilitator.getDisputes(mockAgentAddress);
      const resolvedDispute = disputes.find(d => d.id === dispute.id);

      expect(resolvedDispute?.status).toBe('resolved');
      expect(resolvedDispute?.resolution).toBe('Data was valid');

      // Authorization should be back to validated
      const auth = facilitator.getAuthorization(authorization.id);
      expect(auth?.status).toBe('validated');
    });

    test('should resolve dispute with approval', async () => {
      const authorization = await createValidAuthorization(facilitator, {
        id: 'auth_approve_001',
        agentAddress: mockAgentAddress,
        amount: '0.001'
      });

      const dispute = await facilitator.createDispute({
        authorizationId: authorization.id,
        agentAddress: mockAgentAddress,
        reason: 'Legitimate issue'
      });

      // Approve dispute (cancel authorization)
      await facilitator.resolveDispute(dispute.id, 'approved', 'Agent was right');

      // Authorization should remain disputed
      const auth = facilitator.getAuthorization(authorization.id);
      expect(auth?.status).toBe('disputed');
    });
  });

  describe('Agent Usage Tracking', () => {
    test('should track agent usage correctly', async () => {
      await createValidAuthorization(facilitator, {
        id: 'auth_usage_001',
        agentAddress: mockAgentAddress,
        amount: '0.2'
      });

      await createValidAuthorization(facilitator, {
        id: 'auth_usage_002',
        agentAddress: mockAgentAddress,
        amount: '0.3'
      });

      const usage = facilitator.getAgentUsage(mockAgentAddress);

      expect(usage.requestCount).toBe(2);
      expect(usage.totalAmount).toBe(0.5);
      expect(usage.authorizations.length).toBe(2);
      expect(usage.firstRequestAt).toBeDefined();
      expect(usage.lastRequestAt).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    test('should cleanup expired authorizations', async () => {
      // Create expired authorization
      const expiredAuth: PaymentAuthorization = {
        id: 'auth_expired_001',
        agentAddress: mockAgentAddress,
        merchantAddress: mockMerchantAddress,
        toolName: 'test',
        amount: '0.001',
        currency: 'USDC',
        timestamp: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000, // Expired 1 hour ago
        nonce: 'test_nonce',
        signature: 'mock_sig',
        status: 'pending'
      };

      // Manually add to facilitator (bypass verification)
      (facilitator as any).authorizations[expiredAuth.id] = expiredAuth;

      const cleaned = facilitator.cleanupExpired();

      expect(cleaned).toBe(1);

      const auth = facilitator.getAuthorization(expiredAuth.id);
      expect(auth?.status).toBe('expired');
    });
  });
});

// Helper function to create valid authorization
async function createValidAuthorization(
  facilitator: FacilitatorService,
  params: {
    id: string;
    agentAddress: string;
    amount: string;
    merchantAddress?: string;
  }
): Promise<PaymentAuthorization> {
  const crypto = require('crypto');
  
  const authorization: PaymentAuthorization = {
    id: params.id,
    agentAddress: params.agentAddress,
    merchantAddress: params.merchantAddress || 'mockMerchant456',
    toolName: 'testTool',
    amount: params.amount,
    currency: 'USDC',
    timestamp: Date.now(),
    expiresAt: Date.now() + 3600000,
    nonce: crypto.randomBytes(32).toString('hex'),
    signature: '',
    status: 'pending'
  };

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

  authorization.signature = crypto.createHash('sha256').update(payload).digest('hex');

  const result = await facilitator.verifyAuthorization(authorization);
  if (!result.valid) {
    throw new Error(`Failed to create valid authorization: ${result.reason}`);
  }

  return authorization;
}

