/**
 * Settlement Service
 * 
 * Handles batch settlement execution with automatic triggering:
 * - Monitors queued authorizations
 * - Triggers settlement when thresholds are met
 * - Executes on-chain batch transactions
 * - Handles settlement failures and retries
 */

import { FacilitatorService } from './FacilitatorService';
import type { SettlementBatch, SettlementThreshold } from '@darkresearch/mallory-shared';
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createTransferInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export interface SettlementServiceConfig {
  facilitator: FacilitatorService;
  solanaRpcUrl: string;
  usdcMint: string;
  autoTrigger: boolean;
  checkInterval: number; // milliseconds
  gridContext?: {
    gridSessionSecrets: any;
    gridSession: any;
  };
}

export class SettlementService {
  private facilitator: FacilitatorService;
  private connection: Connection;
  private usdcMint: string;
  private autoTrigger: boolean;
  private checkInterval: number;
  private intervalHandle?: NodeJS.Timeout;
  private gridContext?: SettlementServiceConfig['gridContext'];
  private processing = new Set<string>(); // Track batches being processed

  constructor(config: SettlementServiceConfig) {
    this.facilitator = config.facilitator;
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
    this.usdcMint = config.usdcMint;
    this.autoTrigger = config.autoTrigger;
    this.checkInterval = config.checkInterval;
    this.gridContext = config.gridContext;
  }

  /**
   * Start automatic settlement monitoring
   */
  start(): void {
    if (!this.autoTrigger) {
      console.log('⚠️ [Settlement] Auto-trigger disabled');
      return;
    }

    console.log('🔄 [Settlement] Starting automatic settlement monitoring');
    console.log(`   Check interval: ${this.checkInterval / 1000}s`);

    this.intervalHandle = setInterval(() => {
      this.checkAndTriggerSettlements().catch(error => {
        console.error('❌ [Settlement] Auto-trigger error:', error);
      });
    }, this.checkInterval);
  }

  /**
   * Stop automatic settlement monitoring
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      console.log('🛑 [Settlement] Stopped automatic settlement monitoring');
    }
  }

  /**
   * Check all agents and trigger settlements if thresholds are met
   */
  async checkAndTriggerSettlements(): Promise<void> {
    console.log('🔍 [Settlement] Checking for settlements to trigger...');

    // Get all unique agent-merchant pairs from pending authorizations
    const agentMerchantPairs = new Map<string, Set<string>>();
    
    // Scan all authorizations for unique agent-merchant pairs
    const allAuths = Object.values((this.facilitator as any).authorizations || {});
    allAuths.forEach((auth: any) => {
      if (auth.status === 'validated') {
        if (!agentMerchantPairs.has(auth.agentAddress)) {
          agentMerchantPairs.set(auth.agentAddress, new Set());
        }
        agentMerchantPairs.get(auth.agentAddress)!.add(auth.merchantAddress);
      }
    });

    if (agentMerchantPairs.size === 0) {
      console.log('   No pending settlements');
      return;
    }

    console.log(`   Found ${agentMerchantPairs.size} agent(s) with pending authorizations`);

    // Check each agent-merchant combination
    for (const [agentAddress, merchants] of agentMerchantPairs) {
      for (const merchantAddress of merchants) {
        const pendingAuths = this.facilitator.listPendingAuthorizations(agentAddress)
          .filter(auth => auth.merchantAddress === merchantAddress);
        
        if (pendingAuths.length === 0) {
          continue;
        }

        // Check if settlement should be triggered
        const usage = this.facilitator.getAgentUsage(agentAddress);
        const shouldSettle = this.checkThresholds(pendingAuths, usage);

        if (shouldSettle) {
          console.log(`🎯 [Settlement] Triggering settlement for agent: ${agentAddress.substring(0, 8)}...`);
          console.log(`   Merchant: ${merchantAddress}`);
          
          try {
            await this.triggerSettlement(agentAddress, merchantAddress);
          } catch (error) {
            console.error(`❌ [Settlement] Failed to trigger for ${agentAddress.substring(0, 8)}:`, error);
          }
        }
      }
    }
  }

  /**
   * Check if settlement thresholds are met
   */
  private checkThresholds(authorizations: any[], usage: any): boolean {
    const thresholds = (this.facilitator as any).settlementThresholds;
    
    // Calculate totals
    const totalAmount = authorizations.reduce((sum, auth) => sum + parseFloat(auth.amount), 0);
    const totalCount = authorizations.length;
    const timeSinceFirst = (Date.now() - usage.firstRequestAt) / 1000; // seconds

    // Check thresholds
    const amountThreshold = parseFloat(thresholds.amountThreshold);
    const meetsAmount = totalAmount >= amountThreshold;
    const meetsTime = timeSinceFirst >= thresholds.timeThreshold;
    const meetsCount = totalCount >= thresholds.countThreshold;

    return meetsAmount || meetsTime || meetsCount;
  }

  /**
   * Trigger settlement for a specific agent
   * Creates separate batches for each merchant
   */
  async triggerSettlement(agentAddress: string, merchantAddress?: string): Promise<SettlementBatch | null> {
    const processingKey = merchantAddress ? `${agentAddress}:${merchantAddress}` : agentAddress;
    
    // Check if already processing
    if (this.processing.has(processingKey)) {
      console.log(`⚠️ [Settlement] Already processing settlement for ${agentAddress.substring(0, 8)}`);
      return null;
    }

    this.processing.add(processingKey);

    try {
      // If no merchant specified, get all pending merchants
      const merchants = merchantAddress 
        ? [merchantAddress] 
        : this.facilitator.getPendingMerchants(agentAddress);
      
      if (merchants.length === 0) {
        console.log('⚠️ [Settlement] No merchants with pending authorizations');
        return null;
      }
      
      // Process first merchant (could be extended to process all)
      const targetMerchant = merchants[0];
      
      // Create settlement batch for this merchant
      const batch = this.facilitator.createSettlementBatch(agentAddress, targetMerchant);
      
      if (!batch) {
        console.log('⚠️ [Settlement] No batch to settle');
        return null;
      }

      console.log(`💰 [Settlement] Executing batch settlement: ${batch.id}`);
      console.log(`   Merchant: ${batch.merchantAddress}`);
      console.log(`   Amount: ${batch.totalAmount} ${batch.currency}`);
      console.log(`   Authorizations: ${batch.authorizations.length}`);

      // Execute on-chain settlement
      const signature = await this.executeSettlement(batch);

      // Mark batch as completed
      await this.facilitator.completeSettlement(batch.id, signature);

      console.log(`✅ [Settlement] Batch settled: ${batch.id}`);
      console.log(`   Transaction: ${signature}`);

      return batch;
    } catch (error) {
      console.error('❌ [Settlement] Settlement execution failed:', error);
      
      // Try to get the batch and mark it as failed
      const batches = this.facilitator.getSettlementBatches(agentAddress);
      const latestBatch = batches[batches.length - 1];
      
      if (latestBatch && latestBatch.status === 'pending') {
        await this.facilitator.failSettlement(
          latestBatch.id,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }

      throw error;
    } finally {
      this.processing.delete(processingKey);
    }
  }

  /**
   * Execute on-chain settlement transaction
   */
  private async executeSettlement(batch: SettlementBatch): Promise<string> {
    console.log('🔗 [Settlement] Executing on-chain transaction...');

    if (!this.gridContext) {
      throw new Error('Grid context not available for settlement');
    }

    // Import Grid client for transaction signing
    const { createGridClient } = await import('../../lib/gridClient');
    const gridClient = createGridClient();

    const { gridSessionSecrets, gridSession } = this.gridContext;
    const senderAddress = gridSession.address;

    // Build transfer instruction for USDC
    const senderTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(this.usdcMint),
      new PublicKey(senderAddress),
      true // allowOwnerOffCurve for Grid PDA
    );

    const recipientTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(this.usdcMint),
      new PublicKey(batch.merchantAddress),
      false
    );

    // Convert amount to smallest unit (6 decimals for USDC)
    const amountInSmallestUnit = Math.floor(parseFloat(batch.totalAmount) * 1_000_000);

    const transferIx = createTransferInstruction(
      senderTokenAccount,
      recipientTokenAccount,
      new PublicKey(senderAddress),
      amountInSmallestUnit,
      [],
      TOKEN_PROGRAM_ID
    );

    // Get recent blockhash
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    // Build transaction
    const message = new TransactionMessage({
      payerKey: new PublicKey(senderAddress),
      recentBlockhash: blockhash,
      instructions: [transferIx]
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    const serialized = Buffer.from(transaction.serialize()).toString('base64');

    // Prepare and sign via Grid
    const transactionPayload = await gridClient.prepareArbitraryTransaction(
      senderAddress,
      {
        transaction: serialized,
        fee_config: {
          currency: 'sol',
          payer_address: senderAddress,
          self_managed_fees: false
        }
      }
    );

    if (!transactionPayload || !transactionPayload.data) {
      throw new Error('Failed to prepare transaction with Grid');
    }

    // Sign and send
    const result = await gridClient.signAndSend({
      sessionSecrets: gridSessionSecrets,
      session: gridSession.authentication,
      transactionPayload: transactionPayload.data,
      address: senderAddress
    });

    const signature = result.transaction_signature || 'success';
    console.log('✅ [Settlement] Transaction signed and sent:', signature);

    return signature;
  }

  /**
   * Get settlement statistics
   */
  getStatistics() {
    const batches = this.facilitator.getSettlementBatches();
    
    const total = batches.length;
    const completed = batches.filter(b => b.status === 'completed').length;
    const failed = batches.filter(b => b.status === 'failed').length;
    const pending = batches.filter(b => b.status === 'pending').length;

    const totalVolume = batches
      .filter(b => b.status === 'completed')
      .reduce((sum, b) => sum + parseFloat(b.totalAmount), 0);

    return {
      total,
      completed,
      failed,
      pending,
      totalVolume: totalVolume.toFixed(6),
      processing: this.processing.size,
      autoTrigger: this.autoTrigger,
      isRunning: !!this.intervalHandle
    };
  }

  /**
   * Force settlement for a specific agent (manual trigger)
   */
  async forceSettlement(agentAddress: string): Promise<SettlementBatch | null> {
    console.log(`🔨 [Settlement] Force settling for agent: ${agentAddress.substring(0, 8)}...`);
    return this.triggerSettlement(agentAddress);
  }
}

