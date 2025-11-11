/**
 * Monitoring and Analytics Service
 * 
 * Tracks and analyzes deferred payment system performance:
 * - Payment flow metrics
 * - Settlement patterns
 * - Dispute statistics
 * - Agent behavior analytics
 * - System health monitoring
 */

import { FacilitatorService } from './FacilitatorService';
import { SettlementService } from './SettlementService';
import type { PaymentAuthorization, SettlementBatch, DisputeRecord } from '@darkresearch/mallory-shared';

export interface PaymentMetrics {
  totalAuthorizations: number;
  pendingAuthorizations: number;
  validatedAuthorizations: number;
  settledAuthorizations: number;
  disputedAuthorizations: number;
  expiredAuthorizations: number;
  totalVolume: string;
  averageAmount: string;
  authorizationRate: number; // per hour
}

export interface SettlementMetrics {
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  pendingBatches: number;
  totalSettled: string;
  averageBatchSize: number;
  averageBatchAmount: string;
  settlementRate: number; // per hour
  averageSettlementTime: number; // seconds
}

export interface DisputeMetrics {
  totalDisputes: number;
  pendingDisputes: number;
  resolvedDisputes: number;
  approvedDisputes: number;
  rejectedDisputes: number;
  disputeRate: number; // percentage of total authorizations
  averageResolutionTime: number; // seconds
}

export interface AgentAnalytics {
  agentAddress: string;
  totalAuthorizations: number;
  totalVolume: string;
  averageAmount: string;
  disputes: number;
  disputeRate: number;
  firstSeen: number;
  lastSeen: number;
  reputationScore: number; // 0-100
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'down';
  uptime: number; // seconds
  lastCheck: number;
  issues: string[];
  autoSettlementRunning: boolean;
  queueBacklog: number;
  processingDelay: number; // seconds
}

export class MonitoringService {
  private facilitator: FacilitatorService;
  private settlementService: SettlementService;
  private startTime: number;
  private metricsHistory: {
    timestamp: number;
    payments: PaymentMetrics;
    settlements: SettlementMetrics;
    disputes: DisputeMetrics;
  }[] = [];
  private maxHistorySize = 1000; // Keep last 1000 snapshots

  constructor(config: {
    facilitator: FacilitatorService;
    settlementService: SettlementService;
  }) {
    this.facilitator = config.facilitator;
    this.settlementService = config.settlementService;
    this.startTime = Date.now();
  }

  /**
   * Get current payment metrics
   */
  getPaymentMetrics(): PaymentMetrics {
    const authorizations = Object.values((this.facilitator as any).authorizations || {});
    
    const total = authorizations.length;
    const pending = authorizations.filter((a: any) => a.status === 'pending').length;
    const validated = authorizations.filter((a: any) => a.status === 'validated').length;
    const settled = authorizations.filter((a: any) => a.status === 'settled').length;
    const disputed = authorizations.filter((a: any) => a.status === 'disputed').length;
    const expired = authorizations.filter((a: any) => a.status === 'expired').length;

    const totalVolume = authorizations.reduce((sum: number, a: any) => sum + parseFloat(a.amount), 0);
    const averageAmount = total > 0 ? (totalVolume / total).toFixed(6) : '0';

    // Calculate authorization rate (per hour)
    const uptime = (Date.now() - this.startTime) / 1000 / 3600; // hours
    const authorizationRate = uptime > 0 ? total / uptime : 0;

    return {
      totalAuthorizations: total,
      pendingAuthorizations: pending,
      validatedAuthorizations: validated,
      settledAuthorizations: settled,
      disputedAuthorizations: disputed,
      expiredAuthorizations: expired,
      totalVolume: totalVolume.toFixed(6),
      averageAmount,
      authorizationRate: parseFloat(authorizationRate.toFixed(2))
    };
  }

  /**
   * Get current settlement metrics
   */
  getSettlementMetrics(): SettlementMetrics {
    const batches = this.facilitator.getSettlementBatches();
    
    const total = batches.length;
    const completed = batches.filter(b => b.status === 'completed').length;
    const failed = batches.filter(b => b.status === 'failed').length;
    const pending = batches.filter(b => b.status === 'pending').length;

    const completedBatches = batches.filter(b => b.status === 'completed');
    const totalSettled = completedBatches.reduce((sum, b) => sum + parseFloat(b.totalAmount), 0);
    
    const averageBatchSize = total > 0 
      ? batches.reduce((sum, b) => sum + b.authorizations.length, 0) / total 
      : 0;
    
    const averageBatchAmount = completed > 0
      ? (totalSettled / completed).toFixed(6)
      : '0';

    // Calculate settlement rate (per hour)
    const uptime = (Date.now() - this.startTime) / 1000 / 3600; // hours
    const settlementRate = uptime > 0 ? completed / uptime : 0;

    // Calculate average settlement time
    const settlementTimes = completedBatches
      .filter(b => b.settledAt)
      .map(b => (b.settledAt! - b.createdAt) / 1000); // seconds
    
    const averageSettlementTime = settlementTimes.length > 0
      ? settlementTimes.reduce((sum, t) => sum + t, 0) / settlementTimes.length
      : 0;

    return {
      totalBatches: total,
      completedBatches: completed,
      failedBatches: failed,
      pendingBatches: pending,
      totalSettled: totalSettled.toFixed(6),
      averageBatchSize: parseFloat(averageBatchSize.toFixed(2)),
      averageBatchAmount,
      settlementRate: parseFloat(settlementRate.toFixed(2)),
      averageSettlementTime: parseFloat(averageSettlementTime.toFixed(2))
    };
  }

  /**
   * Get current dispute metrics
   */
  getDisputeMetrics(): DisputeMetrics {
    const disputes = this.facilitator.getDisputes();
    const authorizations = Object.values((this.facilitator as any).authorizations || {});
    
    const total = disputes.length;
    const pending = disputes.filter(d => d.status === 'pending').length;
    const resolved = disputes.filter(d => d.status === 'resolved').length;
    
    // Count approved/rejected based on resolution field
    const resolvedDisputes = disputes.filter(d => d.status === 'resolved');
    const approved = resolvedDisputes.filter(d => {
      const auth = authorizations.find((a: any) => a.id === d.authorizationId);
      return auth && (auth as any).status === 'disputed';
    }).length;
    const rejected = resolved - approved;

    // Calculate dispute rate
    const disputeRate = authorizations.length > 0
      ? (total / authorizations.length) * 100
      : 0;

    // Calculate average resolution time
    const resolutionTimes = resolvedDisputes
      .filter(d => d.resolvedAt)
      .map(d => (d.resolvedAt! - d.createdAt) / 1000); // seconds
    
    const averageResolutionTime = resolutionTimes.length > 0
      ? resolutionTimes.reduce((sum, t) => sum + t, 0) / resolutionTimes.length
      : 0;

    return {
      totalDisputes: total,
      pendingDisputes: pending,
      resolvedDisputes: resolved,
      approvedDisputes: approved,
      rejectedDisputes: rejected,
      disputeRate: parseFloat(disputeRate.toFixed(2)),
      averageResolutionTime: parseFloat(averageResolutionTime.toFixed(2))
    };
  }

  /**
   * Get analytics for a specific agent
   */
  getAgentAnalytics(agentAddress: string): AgentAnalytics {
    const usage = this.facilitator.getAgentUsage(agentAddress);
    const authorizations = this.facilitator.listAuthorizationsByAgent(agentAddress);
    const disputes = this.facilitator.getDisputes(agentAddress);

    const totalAuths = authorizations.length;
    const totalDisputes = disputes.length;
    const disputeRate = totalAuths > 0 ? (totalDisputes / totalAuths) * 100 : 0;

    // Calculate reputation score (0-100)
    // Higher score = fewer disputes, more settled authorizations
    const settledCount = authorizations.filter(a => a.status === 'settled').length;
    const settledRate = totalAuths > 0 ? (settledCount / totalAuths) * 100 : 100;
    const disputePenalty = disputeRate * 2; // Each dispute reduces score by 2%
    const reputationScore = Math.max(0, Math.min(100, settledRate - disputePenalty));

    return {
      agentAddress,
      totalAuthorizations: totalAuths,
      totalVolume: usage.totalAmount.toFixed(6),
      averageAmount: totalAuths > 0 ? (usage.totalAmount / totalAuths).toFixed(6) : '0',
      disputes: totalDisputes,
      disputeRate: parseFloat(disputeRate.toFixed(2)),
      firstSeen: usage.firstRequestAt,
      lastSeen: usage.lastRequestAt,
      reputationScore: parseFloat(reputationScore.toFixed(2))
    };
  }

  /**
   * Get all agent analytics
   */
  getAllAgentAnalytics(): AgentAnalytics[] {
    const agentUsage = (this.facilitator as any).agentUsage || {};
    const agentAddresses = Object.keys(agentUsage);

    return agentAddresses.map(address => this.getAgentAnalytics(address));
  }

  /**
   * Get system health status
   */
  getSystemHealth(): SystemHealth {
    const uptime = (Date.now() - this.startTime) / 1000; // seconds
    const settlementStats = this.settlementService.getStatistics();
    const queueBacklog = (this.facilitator as any).settlementQueue?.length || 0;
    
    const issues: string[] = [];
    let status: SystemHealth['status'] = 'healthy';

    // Check for issues
    if (!settlementStats.isRunning && settlementStats.autoTrigger) {
      issues.push('Auto-settlement service not running');
      status = 'degraded';
    }

    if (settlementStats.failed > settlementStats.completed * 0.1) {
      issues.push('High settlement failure rate');
      status = 'degraded';
    }

    if (queueBacklog > 1000) {
      issues.push('Large settlement queue backlog');
      status = 'degraded';
    }

    // Estimate processing delay
    const processingDelay = settlementStats.autoTrigger
      ? queueBacklog * 2 // Rough estimate: 2 seconds per authorization
      : 0;

    if (issues.length > 3) {
      status = 'down';
    }

    return {
      status,
      uptime: parseFloat(uptime.toFixed(2)),
      lastCheck: Date.now(),
      issues,
      autoSettlementRunning: settlementStats.isRunning,
      queueBacklog,
      processingDelay: parseFloat(processingDelay.toFixed(2))
    };
  }

  /**
   * Take a metrics snapshot and store in history
   */
  takeSnapshot(): void {
    const snapshot = {
      timestamp: Date.now(),
      payments: this.getPaymentMetrics(),
      settlements: this.getSettlementMetrics(),
      disputes: this.getDisputeMetrics()
    };

    this.metricsHistory.push(snapshot);

    // Keep history size manageable
    if (this.metricsHistory.length > this.maxHistorySize) {
      this.metricsHistory.shift();
    }
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(limit?: number) {
    const history = this.metricsHistory;
    
    if (limit && limit < history.length) {
      return history.slice(-limit);
    }
    
    return history;
  }

  /**
   * Get comprehensive dashboard data
   */
  getDashboard() {
    return {
      timestamp: Date.now(),
      health: this.getSystemHealth(),
      payments: this.getPaymentMetrics(),
      settlements: this.getSettlementMetrics(),
      disputes: this.getDisputeMetrics(),
      topAgents: this.getTopAgents(10),
      recentActivity: this.getRecentActivity(20)
    };
  }

  /**
   * Get top agents by volume
   */
  private getTopAgents(limit: number): AgentAnalytics[] {
    const allAgents = this.getAllAgentAnalytics();
    
    return allAgents
      .sort((a, b) => parseFloat(b.totalVolume) - parseFloat(a.totalVolume))
      .slice(0, limit);
  }

  /**
   * Get recent activity
   */
  private getRecentActivity(limit: number) {
    const authorizations = Object.values((this.facilitator as any).authorizations || {});
    const batches = this.facilitator.getSettlementBatches();
    const disputes = this.facilitator.getDisputes();

    const activity = [
      ...authorizations.map((a: any) => ({
        type: 'authorization' as const,
        timestamp: a.timestamp,
        data: a
      })),
      ...batches.map(b => ({
        type: 'settlement' as const,
        timestamp: b.createdAt,
        data: b
      })),
      ...disputes.map(d => ({
        type: 'dispute' as const,
        timestamp: d.createdAt,
        data: d
      }))
    ];

    return activity
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Start periodic snapshot collection
   */
  startSnapshotCollection(intervalSeconds: number = 300): void {
    setInterval(() => {
      this.takeSnapshot();
    }, intervalSeconds * 1000);

    console.log(`📊 [Monitoring] Started snapshot collection (interval: ${intervalSeconds}s)`);
  }
}

