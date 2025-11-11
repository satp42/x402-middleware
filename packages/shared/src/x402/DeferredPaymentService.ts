/**
 * Deferred Payment Service
 * 
 * Extends X402PaymentService with deferred payment capabilities:
 * - Fetch data first, pay after validation
 * - Batch multiple requests for aggregated settlement
 * - Support temporary credit with escrow mechanisms
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { X402PaymentService } from './X402PaymentService';
import { EphemeralWalletManager, type GridTokenSender } from './EphemeralWalletManager';
import type {
  X402PaymentRequirement,
  DeferredPaymentRequirement,
  PaymentAuthorization,
  PaymentMode,
  FacilitatorConfig
} from './types';
import { createHash, randomBytes } from 'crypto';

export interface FetchWithCreditResult {
  data: any;
  authorization: PaymentAuthorization;
}

export interface DeferredPaymentConfig {
  solanaRpcUrl: string;
  solanaCluster: 'mainnet-beta' | 'devnet' | 'testnet';
  usdcMint: string;
  ephemeralFundingUsdc: string;
  ephemeralFundingSol: string;
  facilitatorConfig: FacilitatorConfig;
}

export class DeferredPaymentService extends X402PaymentService {
  private facilitatorConfig: FacilitatorConfig;

  constructor(config: DeferredPaymentConfig) {
    super({
      solanaRpcUrl: config.solanaRpcUrl,
      solanaCluster: config.solanaCluster,
      usdcMint: config.usdcMint,
      ephemeralFundingUsdc: config.ephemeralFundingUsdc,
      ephemeralFundingSol: config.ephemeralFundingSol
    });
    this.facilitatorConfig = config.facilitatorConfig;
  }

  /**
   * Fetch data with temporary credit (deferred payment)
   * 
   * Flow:
   * 1. Make initial request to get 402 Payment Required response
   * 2. Extract recipient address from 402 response
   * 3. Create authorization with dynamic recipient
   * 4. Store authorization with facilitator
   * 5. Retry request with authorization header
   * 6. Return data + authorization for later settlement
   */
  async fetchWithCredit(
    requirements: DeferredPaymentRequirement,
    gridWalletAddress: string,
    gridSender: GridTokenSender
  ): Promise<FetchWithCreditResult> {
    const { apiUrl, method, headers, body, estimatedCost, toolName } = requirements;

    console.log('🔄 [Deferred] Starting deferred payment flow...');
    console.log('   Tool:', toolName);
    console.log('   Mode:', requirements.paymentMode);
    console.log('   Cost:', estimatedCost.amount, estimatedCost.currency);

    // Step 1: Make initial request to get 402 Payment Required response
    console.log('🌐 [Deferred] Making initial request to get 402 response...');
    const initialResponse = await fetch(apiUrl, {
      method,
      headers,
      body: JSON.stringify(body)
    });

    // Step 2: Extract payment requirements from 402 response
    let merchantAddress: string;
    let actualAmount: string;
    let actualCurrency: string;
    
    if (initialResponse.status === 402) {
      console.log('💳 [Deferred] Received 402 Payment Required');
      
      // Parse x402 payment requirements from response
      const paymentRequired = await this.parse402Response(initialResponse);
      
      if (!paymentRequired) {
        throw new Error('Failed to parse 402 payment requirements');
      }
      
      merchantAddress = paymentRequired.recipient;
      actualAmount = paymentRequired.amount;
      actualCurrency = paymentRequired.currency;
      
      console.log('   Merchant (from 402):', merchantAddress);
      console.log('   Amount (from 402):', actualAmount, actualCurrency);
    } else if (initialResponse.ok) {
      // Data returned without payment requirement (free endpoint?)
      console.log('✅ [Deferred] Data returned without payment requirement');
      const data = await initialResponse.json();
      
      // Create a zero-amount authorization for tracking
      const authorization: PaymentAuthorization = {
        id: this.generateAuthorizationId(),
        agentAddress: gridWalletAddress,
        merchantAddress: 'none',
        toolName,
        amount: '0',
        currency: 'USDC',
        timestamp: Date.now(),
        expiresAt: Date.now() + 3600000,
        nonce: this.generateNonce(),
        signature: '',
        status: 'settled', // Already "settled" since no payment needed
        dataHash: this.hashData(data)
      };
      
      return { data, authorization };
    } else {
      // Unexpected response
      const errorText = await initialResponse.text();
      throw new Error(`Unexpected response: ${initialResponse.status} ${errorText}`);
    }

    // Step 3: Create payment authorization with dynamic merchant address
    const authorization = await this.createAuthorization({
      agentAddress: gridWalletAddress,
      merchantAddress, // From 402 response!
      toolName,
      amount: actualAmount,
      currency: actualCurrency,
      expiresIn: requirements.deferredTerms?.settlementPeriod 
        ? requirements.deferredTerms.settlementPeriod * 3600 
        : 3600 // 1 hour default
    });

    console.log('✅ [Deferred] Authorization created:', authorization.id);

    // Step 4: Register authorization with facilitator
    await this.registerAuthorizationWithFacilitator(authorization);

    // Step 5: Retry request with authorization header
    console.log('🔄 [Deferred] Retrying request with authorization...');
    try {
      const response = await fetch(apiUrl, {
        method,
        headers: {
          ...headers,
          'X-PAYMENT-AUTH': this.encodeAuthorization(authorization),
          'X-DEFERRED-PAYMENT': 'true'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      
      // Step 6: Calculate data hash for validation
      const dataHash = this.hashData(data);
      authorization.dataHash = dataHash;

      console.log('✅ [Deferred] Data fetched successfully');
      console.log('   Data hash:', dataHash.substring(0, 16) + '...');

      return {
        data,
        authorization
      };
    } catch (error) {
      console.error('❌ [Deferred] Failed to fetch data:', error);
      // Mark authorization as failed
      authorization.status = 'disputed';
      throw error;
    }
  }

  /**
   * Validate data quality before payment
   */
  async validateDataQuality(
    data: any,
    requirements: DeferredPaymentRequirement
  ): Promise<boolean> {
    console.log('🔍 [Deferred] Validating data quality...');

    // Basic validation checks
    if (!data) {
      console.error('❌ Data is null or undefined');
      return false;
    }

    // Check if data has expected structure
    if (typeof data === 'object' && Object.keys(data).length === 0) {
      console.error('❌ Data is empty object');
      return false;
    }

    // Check for common error patterns
    if (data.error || data.message?.toLowerCase().includes('error')) {
      console.error('❌ Data contains error:', data.error || data.message);
      return false;
    }

    // Tool-specific validation could be added here
    // For now, basic checks pass
    console.log('✅ [Deferred] Data validation passed');
    return true;
  }

  /**
   * Create a signed payment authorization
   */
  private async createAuthorization(params: {
    agentAddress: string;
    merchantAddress: string;
    toolName: string;
    amount: string;
    currency: string;
    expiresIn: number;
  }): Promise<PaymentAuthorization> {
    const now = Date.now();
    const nonce = this.generateNonce();
    
    const authorization: PaymentAuthorization = {
      id: this.generateAuthorizationId(),
      agentAddress: params.agentAddress,
      merchantAddress: params.merchantAddress,
      toolName: params.toolName,
      amount: params.amount,
      currency: params.currency,
      timestamp: now,
      expiresAt: now + (params.expiresIn * 1000),
      nonce,
      signature: '', // Will be filled by signing
      status: 'pending'
    };

    // Create signature payload
    const signaturePayload = this.createSignaturePayload(authorization);
    
    // For now, create a simple hash-based signature
    // In production, this should use the agent's wallet to sign
    authorization.signature = this.signPayload(signaturePayload);

    return authorization;
  }

  /**
   * Register authorization with facilitator service
   */
  private async registerAuthorizationWithFacilitator(
    authorization: PaymentAuthorization
  ): Promise<void> {
    console.log('📤 [Deferred] Registering authorization with facilitator...');
    
    try {
      const response = await fetch(`${this.facilitatorConfig.url}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(authorization)
      });

      if (!response.ok) {
        throw new Error(`Facilitator verification failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ [Deferred] Authorization registered:', result);
    } catch (error) {
      console.error('❌ [Deferred] Failed to register authorization:', error);
      throw new Error('Failed to register authorization with facilitator');
    }
  }

  /**
   * Queue authorization for settlement
   */
  async queueForSettlement(authorization: PaymentAuthorization): Promise<void> {
    console.log('📥 [Deferred] Queueing authorization for settlement...');
    
    try {
      const response = await fetch(`${this.facilitatorConfig.url}/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          authorizationId: authorization.id,
          agentAddress: authorization.agentAddress
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to queue for settlement: ${response.status}`);
      }

      console.log('✅ [Deferred] Authorization queued for settlement');
    } catch (error) {
      console.error('❌ [Deferred] Failed to queue for settlement:', error);
      throw error;
    }
  }

  /**
   * Execute immediate settlement for a specific authorization
   */
  async settleNow(
    authorization: PaymentAuthorization,
    gridWalletAddress: string,
    gridSender: GridTokenSender
  ): Promise<string> {
    console.log('💰 [Deferred] Executing immediate settlement...');
    console.log('   Authorization:', authorization.id);
    console.log('   Amount:', authorization.amount, authorization.currency);

    // Convert to standard payment requirement
    const paymentReq: X402PaymentRequirement = {
      needsPayment: true,
      toolName: authorization.toolName,
      apiUrl: '', // Not needed for direct settlement
      method: 'POST',
      headers: {},
      body: {},
      estimatedCost: {
        amount: authorization.amount,
        currency: authorization.currency
      }
    };

    // Use parent class's payment method
    // This will handle the ephemeral wallet creation and Faremeter integration
    try {
      // For direct settlement, we just need to send tokens
      const signature = await gridSender.sendTokens({
        recipient: authorization.merchantAddress,
        amount: authorization.amount,
        tokenMint: this.getTokenMint(authorization.currency)
      });

      console.log('✅ [Deferred] Settlement completed');
      console.log('   Transaction:', signature);

      // Notify facilitator of settlement
      await this.notifySettlement(authorization.id, signature);

      return signature;
    } catch (error) {
      console.error('❌ [Deferred] Settlement failed:', error);
      throw error;
    }
  }

  /**
   * Notify facilitator of completed settlement
   */
  private async notifySettlement(
    authorizationId: string,
    transactionSignature: string
  ): Promise<void> {
    try {
      await fetch(`${this.facilitatorConfig.url}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          authorizationId,
          transactionSignature,
          settledAt: Date.now()
        })
      });
    } catch (error) {
      console.error('⚠️ [Deferred] Failed to notify facilitator:', error);
      // Non-critical error, don't throw
    }
  }

  // Helper methods

  private generateAuthorizationId(): string {
    return `auth_${Date.now()}_${randomBytes(16).toString('hex')}`;
  }

  private generateNonce(): string {
    return randomBytes(32).toString('hex');
  }

  private createSignaturePayload(authorization: PaymentAuthorization): string {
    return [
      authorization.id,
      authorization.agentAddress,
      authorization.merchantAddress,
      authorization.amount,
      authorization.currency,
      authorization.timestamp,
      authorization.expiresAt,
      authorization.nonce
    ].join('|');
  }

  private signPayload(payload: string): string {
    // Simple hash-based signature for now
    // In production, use proper wallet signing (EIP-712 for EVM, ed25519 for Solana)
    return createHash('sha256').update(payload).digest('hex');
  }

  private encodeAuthorization(authorization: PaymentAuthorization): string {
    return Buffer.from(JSON.stringify(authorization)).toString('base64');
  }

  private hashData(data: any): string {
    const dataString = JSON.stringify(data);
    return createHash('sha256').update(dataString).digest('hex');
  }

  private getTokenMint(currency: string): string | undefined {
    if (currency.toUpperCase() === 'USDC') {
      return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Mainnet USDC
    }
    return undefined; // Native SOL
  }

  /**
   * Parse 402 Payment Required response to extract payment details
   */
  private async parse402Response(response: Response): Promise<{
    recipient: string;
    amount: string;
    currency: string;
  } | null> {
    try {
      // Try to get payment requirements from headers first
      const paymentHeader = response.headers.get('X-PAYMENT-REQUIRED');
      
      if (paymentHeader) {
        // Decode base64 header
        const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
        
        return {
          recipient: decoded.recipient || decoded.address || decoded.merchantAddress,
          amount: decoded.amount || '0.001',
          currency: decoded.currency || decoded.asset || 'USDC'
        };
      }
      
      // Fallback: try to parse from response body
      const responseText = await response.text();
      
      // Try to parse as JSON
      try {
        const body = JSON.parse(responseText);
        
        // Look for x402 standard fields
        if (body.accepts && Array.isArray(body.accepts) && body.accepts.length > 0) {
          const accept = body.accepts[0]; // Take first accepted payment method
          
          return {
            recipient: accept.recipient || accept.address || body.recipient || body.address,
            amount: accept.amount || body.amount || '0.001',
            currency: accept.asset || accept.currency || body.currency || 'USDC'
          };
        }
        
        // Direct fields
        if (body.recipient || body.address) {
          return {
            recipient: body.recipient || body.address,
            amount: body.amount || '0.001',
            currency: body.currency || body.asset || 'USDC'
          };
        }
      } catch (parseError) {
        console.warn('⚠️ [Deferred] Could not parse 402 body as JSON:', parseError);
      }
      
      // Could not extract payment requirements
      console.error('❌ [Deferred] Failed to extract payment requirements from 402 response');
      return null;
    } catch (error) {
      console.error('❌ [Deferred] Error parsing 402 response:', error);
      return null;
    }
  }
}

