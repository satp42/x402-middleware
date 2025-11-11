/**
 * Facilitator API Routes
 * 
 * REST endpoints for deferred payment management:
 * - POST /verify - Verify payment authorization
 * - POST /queue - Queue authorization for settlement
 * - POST /settle - Complete settlement
 * - POST /dispute - Create dispute
 * - GET /list - List authorizations
 * - GET /batches - List settlement batches
 * - GET /usage - Get agent usage statistics
 */

import { Router, Request, Response } from 'express';
import { FacilitatorService } from '../services/facilitator/FacilitatorService';
import { SettlementService } from '../services/facilitator/SettlementService';
import { MonitoringService } from '../services/facilitator/MonitoringService';
import { X402_CONSTANTS } from '@darkresearch/mallory-shared';
import type { 
  PaymentAuthorization,
  SettlementThreshold 
} from '@darkresearch/mallory-shared';

const router = Router();

// Initialize facilitator service
// In production, these would come from environment variables
const facilitatorService = new FacilitatorService({
  settlementThresholds: {
    amountThreshold: process.env.SETTLEMENT_THRESHOLD_AMOUNT || '1.00',
    timeThreshold: parseInt(process.env.SETTLEMENT_THRESHOLD_TIME || '3600'), // 1 hour
    countThreshold: parseInt(process.env.SETTLEMENT_THRESHOLD_COUNT || '100')
  }
});

// Initialize settlement service
const settlementService = new SettlementService({
  facilitator: facilitatorService,
  solanaRpcUrl: process.env.SOLANA_RPC_URL || process.env.EXPO_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  usdcMint: X402_CONSTANTS.USDC_MINT,
  autoTrigger: process.env.AUTO_SETTLEMENT !== 'false', // Default true
  checkInterval: parseInt(process.env.SETTLEMENT_CHECK_INTERVAL || '60000') // 1 minute
  // Grid context will be set when available
});

// Initialize monitoring service
const monitoringService = new MonitoringService({
  facilitator: facilitatorService,
  settlementService
});

// Start settlement service if auto-trigger is enabled
if (process.env.AUTO_SETTLEMENT !== 'false') {
  settlementService.start();
  console.log('✅ [Settlement] Auto-settlement service started');
}

// Start monitoring snapshot collection (every 5 minutes)
monitoringService.startSnapshotCollection(300);

// Run cleanup every 5 minutes
setInterval(() => {
  facilitatorService.cleanupExpired();
}, 5 * 60 * 1000);

/**
 * POST /facilitator/verify
 * Verify and store a payment authorization
 */
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const authorization: PaymentAuthorization = req.body;

    if (!authorization || !authorization.id) {
      return res.status(400).json({
        success: false,
        error: 'Invalid authorization'
      });
    }

    const result = await facilitatorService.verifyAuthorization(authorization);

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        error: result.reason
      });
    }

    res.json({
      success: true,
      authorizationId: authorization.id,
      message: 'Authorization verified and stored'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Verify error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/queue
 * Queue authorization for settlement
 */
router.post('/queue', async (req: Request, res: Response) => {
  try {
    const { authorizationId, agentAddress } = req.body;

    if (!authorizationId || !agentAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: authorizationId, agentAddress'
      });
    }

    const result = await facilitatorService.queueForSettlement(authorizationId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.reason
      });
    }

    res.json({
      success: true,
      authorizationId,
      shouldSettle: result.shouldSettle,
      message: result.reason || 'Authorization queued for settlement'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Queue error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/settle
 * Mark settlement as completed
 */
router.post('/settle', async (req: Request, res: Response) => {
  try {
    const { authorizationId, transactionSignature, settledAt } = req.body;

    if (!authorizationId || !transactionSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: authorizationId, transactionSignature'
      });
    }

    // For single authorization settlement
    const authorization = facilitatorService.getAuthorization(authorizationId);
    if (!authorization) {
      return res.status(404).json({
        success: false,
        error: 'Authorization not found'
      });
    }

    // Update authorization status
    authorization.status = 'settled';

    res.json({
      success: true,
      authorizationId,
      transactionSignature,
      message: 'Settlement recorded'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Settle error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/batch/create
 * Create settlement batch for an agent
 */
router.post('/batch/create', async (req: Request, res: Response) => {
  try {
    const { agentAddress, merchantAddress } = req.body;

    if (!agentAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: agentAddress'
      });
    }

    const batch = facilitatorService.createSettlementBatch(agentAddress, merchantAddress);

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: 'No authorizations to settle'
      });
    }

    res.json({
      success: true,
      batch
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Create batch error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/batch/complete
 * Mark settlement batch as completed
 */
router.post('/batch/complete', async (req: Request, res: Response) => {
  try {
    const { batchId, transactionSignature } = req.body;

    if (!batchId || !transactionSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: batchId, transactionSignature'
      });
    }

    await facilitatorService.completeSettlement(batchId, transactionSignature);

    res.json({
      success: true,
      batchId,
      transactionSignature,
      message: 'Settlement batch completed'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Complete batch error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/batch/fail
 * Mark settlement batch as failed
 */
router.post('/batch/fail', async (req: Request, res: Response) => {
  try {
    const { batchId, error } = req.body;

    if (!batchId || !error) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: batchId, error'
      });
    }

    await facilitatorService.failSettlement(batchId, error);

    res.json({
      success: true,
      batchId,
      message: 'Settlement batch marked as failed'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Fail batch error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/list
 * List authorizations for an agent
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const { agentAddress, status } = req.query;

    if (!agentAddress || typeof agentAddress !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: agentAddress'
      });
    }

    let authorizations = facilitatorService.listAuthorizationsByAgent(agentAddress);

    // Filter by status if provided
    if (status && typeof status === 'string') {
      authorizations = authorizations.filter(auth => auth.status === status);
    }

    res.json({
      success: true,
      authorizations,
      count: authorizations.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] List error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/pending
 * List pending authorizations for an agent
 */
router.get('/pending', async (req: Request, res: Response) => {
  try {
    const { agentAddress } = req.query;

    if (!agentAddress || typeof agentAddress !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: agentAddress'
      });
    }

    const authorizations = facilitatorService.listPendingAuthorizations(agentAddress);

    res.json({
      success: true,
      authorizations,
      count: authorizations.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Pending error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/merchants
 * Get unique merchant addresses from pending authorizations for an agent
 */
router.get('/merchants', async (req: Request, res: Response) => {
  try {
    const { agentAddress } = req.query;

    if (!agentAddress || typeof agentAddress !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: agentAddress'
      });
    }

    const merchants = facilitatorService.getPendingMerchants(agentAddress);

    res.json({
      success: true,
      merchants,
      count: merchants.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Merchants error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/batches
 * List settlement batches
 */
router.get('/batches', async (req: Request, res: Response) => {
  try {
    const { agentAddress } = req.query;

    const batches = facilitatorService.getSettlementBatches(
      agentAddress ? String(agentAddress) : undefined
    );

    res.json({
      success: true,
      batches,
      count: batches.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Batches error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/usage
 * Get usage statistics for an agent
 */
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const { agentAddress } = req.query;

    if (!agentAddress || typeof agentAddress !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: agentAddress'
      });
    }

    const usage = facilitatorService.getAgentUsage(agentAddress);

    res.json({
      success: true,
      usage
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Usage error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/dispute
 * Create a dispute for an authorization
 */
router.post('/dispute', async (req: Request, res: Response) => {
  try {
    const { authorizationId, agentAddress, reason, evidence } = req.body;

    if (!authorizationId || !agentAddress || !reason) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: authorizationId, agentAddress, reason'
      });
    }

    const dispute = await facilitatorService.createDispute({
      authorizationId,
      agentAddress,
      reason,
      evidence
    });

    res.json({
      success: true,
      dispute
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Dispute error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/dispute/resolve
 * Resolve a dispute
 */
router.post('/dispute/resolve', async (req: Request, res: Response) => {
  try {
    const { disputeId, resolution, resolutionNote } = req.body;

    if (!disputeId || !resolution) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: disputeId, resolution'
      });
    }

    if (!['approved', 'rejected'].includes(resolution)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid resolution. Must be "approved" or "rejected"'
      });
    }

    await facilitatorService.resolveDispute(disputeId, resolution, resolutionNote);

    res.json({
      success: true,
      disputeId,
      resolution,
      message: 'Dispute resolved'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Resolve dispute error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/disputes
 * List disputes
 */
router.get('/disputes', async (req: Request, res: Response) => {
  try {
    const { agentAddress } = req.query;

    const disputes = facilitatorService.getDisputes(
      agentAddress ? String(agentAddress) : undefined
    );

    res.json({
      success: true,
      disputes,
      count: disputes.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Disputes error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/settlement/statistics
 * Get settlement statistics
 */
router.get('/settlement/statistics', (req: Request, res: Response) => {
  try {
    const stats = settlementService.getStatistics();
    
    res.json({
      success: true,
      statistics: stats
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Statistics error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/settlement/trigger
 * Manually trigger settlement for an agent
 */
router.post('/settlement/trigger', async (req: Request, res: Response) => {
  try {
    const { agentAddress } = req.body;

    if (!agentAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: agentAddress'
      });
    }

    const batch = await settlementService.forceSettlement(agentAddress);

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: 'No pending authorizations to settle'
      });
    }

    res.json({
      success: true,
      batch
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Trigger settlement error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/settlement/start
 * Start auto-settlement service
 */
router.post('/settlement/start', (req: Request, res: Response) => {
  try {
    settlementService.start();
    
    res.json({
      success: true,
      message: 'Settlement service started'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Start settlement error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * POST /facilitator/settlement/stop
 * Stop auto-settlement service
 */
router.post('/settlement/stop', (req: Request, res: Response) => {
  try {
    settlementService.stop();
    
    res.json({
      success: true,
      message: 'Settlement service stopped'
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Stop settlement error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/monitoring/dashboard
 * Get comprehensive monitoring dashboard
 */
router.get('/monitoring/dashboard', (req: Request, res: Response) => {
  try {
    const dashboard = monitoringService.getDashboard();
    
    res.json({
      success: true,
      dashboard
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Dashboard error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/monitoring/metrics
 * Get current metrics
 */
router.get('/monitoring/metrics', (req: Request, res: Response) => {
  try {
    const { type } = req.query;
    
    let metrics;
    if (type === 'payments') {
      metrics = monitoringService.getPaymentMetrics();
    } else if (type === 'settlements') {
      metrics = monitoringService.getSettlementMetrics();
    } else if (type === 'disputes') {
      metrics = monitoringService.getDisputeMetrics();
    } else {
      metrics = {
        payments: monitoringService.getPaymentMetrics(),
        settlements: monitoringService.getSettlementMetrics(),
        disputes: monitoringService.getDisputeMetrics()
      };
    }
    
    res.json({
      success: true,
      metrics
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Metrics error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/monitoring/agent/:address
 * Get analytics for a specific agent
 */
router.get('/monitoring/agent/:address', (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    
    const analytics = monitoringService.getAgentAnalytics(address);
    
    res.json({
      success: true,
      analytics
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Agent analytics error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/monitoring/agents
 * Get analytics for all agents
 */
router.get('/monitoring/agents', (req: Request, res: Response) => {
  try {
    const analytics = monitoringService.getAllAgentAnalytics();
    
    res.json({
      success: true,
      agents: analytics,
      count: analytics.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] All agents analytics error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/monitoring/health
 * Get system health status
 */
router.get('/monitoring/health', (req: Request, res: Response) => {
  try {
    const health = monitoringService.getSystemHealth();
    
    res.json({
      success: true,
      health
    });
  } catch (error) {
    console.error('❌ [Facilitator API] Health check error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/monitoring/history
 * Get metrics history
 */
router.get('/monitoring/history', (req: Request, res: Response) => {
  try {
    const { limit } = req.query;
    const limitNum = limit ? parseInt(String(limit)) : undefined;
    
    const history = monitoringService.getMetricsHistory(limitNum);
    
    res.json({
      success: true,
      history,
      count: history.length
    });
  } catch (error) {
    console.error('❌ [Facilitator API] History error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
});

/**
 * GET /facilitator/health
 * Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  const health = monitoringService.getSystemHealth();
  
  res.json({
    success: true,
    service: 'facilitator',
    status: health.status,
    timestamp: Date.now(),
    uptime: health.uptime,
    issues: health.issues
  });
});

// Export router and service instances for testing
export default router;
export { facilitatorService, settlementService, monitoringService };

