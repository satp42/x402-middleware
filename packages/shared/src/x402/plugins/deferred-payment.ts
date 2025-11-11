/**
 * Faremeter Deferred Payment Plugin
 * 
 * A Faremeter-compatible payment handler that enables deferred/aggregated payments:
 * - Creates signed authorization instead of immediate payment
 * - Stores authorization with facilitator for batch settlement
 * - Compatible with existing Faremeter infrastructure
 * - Supports both immediate and deferred settlement modes
 */

import type {
  PaymentAuthorization,
  FacilitatorConfig
} from '../types';
import { createHash, randomBytes } from 'crypto';

export interface DeferredPaymentHandlerOptions {
  wallet: {
    network: string;
    publicKey: any; // PublicKey for Solana
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  };
  facilitatorConfig: FacilitatorConfig;
  mode?: 'immediate' | 'deferred' | 'aggregated';
}

export interface PaymentHandlerResult {
  success: boolean;
  authorization?: PaymentAuthorization;
  error?: string;
}

/**
 * Create a deferred payment handler compatible with Faremeter
 * 
 * This handler intercepts the normal Faremeter payment flow and:
 * 1. Creates a signed authorization instead of executing payment
 * 2. Registers the authorization with the facilitator
 * 3. Returns authorization header for the API request
 * 4. Queues the authorization for later batch settlement
 */
export function createDeferredPaymentHandler(
  options: DeferredPaymentHandlerOptions
) {
  const { wallet, facilitatorConfig, mode = 'deferred' } = options;

  return {
    /**
     * Handle payment requirement by creating authorization
     */
    async handlePayment(params: {
      amount: string;
      currency: string;
      merchant: string;
      toolName: string;
      requestId?: string;
    }): Promise<PaymentHandlerResult> {
      console.log('💳 [Deferred Plugin] Handling payment request:', {
        amount: params.amount,
        currency: params.currency,
        mode
      });

      try {
        // Step 1: Create authorization
        const authorization = await createAuthorization({
          agentAddress: wallet.publicKey.toString(),
          merchantAddress: params.merchant,
          toolName: params.toolName,
          amount: params.amount,
          currency: params.currency,
          expiresIn: facilitatorConfig.settlementThresholds.timeThreshold,
          wallet
        });

        // Step 2: Register with facilitator
        await registerWithFacilitator(facilitatorConfig.url, authorization);

        // Step 3: Queue for settlement (if auto-settlement enabled)
        if (facilitatorConfig.autoSettlement) {
          await queueForSettlement(facilitatorConfig.url, authorization.id, wallet.publicKey.toString());
        }

        console.log('✅ [Deferred Plugin] Authorization created and registered');
        return {
          success: true,
          authorization
        };
      } catch (error) {
        console.error('❌ [Deferred Plugin] Failed to create authorization:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    },

    /**
     * Encode authorization for HTTP header
     */
    encodeAuthorization(authorization: PaymentAuthorization): string {
      return Buffer.from(JSON.stringify(authorization)).toString('base64');
    },

    /**
     * Get handler configuration
     */
    getConfig() {
      return {
        mode,
        facilitatorUrl: facilitatorConfig.url,
        merchantAddress: facilitatorConfig.merchantAddress,
        autoSettlement: facilitatorConfig.autoSettlement
      };
    }
  };
}

/**
 * Create a signed payment authorization
 */
async function createAuthorization(params: {
  agentAddress: string;
  merchantAddress: string;
  toolName: string;
  amount: string;
  currency: string;
  expiresIn: number;
  wallet: DeferredPaymentHandlerOptions['wallet'];
}): Promise<PaymentAuthorization> {
  const now = Date.now();
  const nonce = generateNonce();
  
  const authorization: PaymentAuthorization = {
    id: generateAuthorizationId(),
    agentAddress: params.agentAddress,
    merchantAddress: params.merchantAddress,
    toolName: params.toolName,
    amount: params.amount,
    currency: params.currency,
    timestamp: now,
    expiresAt: now + (params.expiresIn * 1000),
    nonce,
    signature: '',
    status: 'pending'
  };

  // Create signature payload
  const signaturePayload = createSignaturePayload(authorization);
  
  // Sign with wallet if signMessage is available
  if (params.wallet.signMessage) {
    try {
      const messageBytes = new TextEncoder().encode(signaturePayload);
      const signatureBytes = await params.wallet.signMessage(messageBytes);
      authorization.signature = Buffer.from(signatureBytes).toString('hex');
    } catch (error) {
      console.error('⚠️ [Deferred Plugin] Wallet signing failed, using hash:', error);
      // Fallback to hash-based signature
      authorization.signature = signPayload(signaturePayload);
    }
  } else {
    // Use hash-based signature as fallback
    authorization.signature = signPayload(signaturePayload);
  }

  return authorization;
}

/**
 * Register authorization with facilitator
 */
async function registerWithFacilitator(
  facilitatorUrl: string,
  authorization: PaymentAuthorization
): Promise<void> {
  console.log('📤 [Deferred Plugin] Registering with facilitator...');
  
  const response = await fetch(`${facilitatorUrl}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(authorization)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Facilitator verification failed: ${response.status} ${error}`);
  }

  const result = await response.json();
  console.log('✅ [Deferred Plugin] Registered:', result);
}

/**
 * Queue authorization for settlement
 */
async function queueForSettlement(
  facilitatorUrl: string,
  authorizationId: string,
  agentAddress: string
): Promise<void> {
  console.log('📥 [Deferred Plugin] Queueing for settlement...');
  
  const response = await fetch(`${facilitatorUrl}/queue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      authorizationId,
      agentAddress
    })
  });

  if (!response.ok) {
    console.warn('⚠️ [Deferred Plugin] Failed to queue for settlement');
    // Non-critical error, don't throw
    return;
  }

  const result = await response.json();
  console.log('✅ [Deferred Plugin] Queued:', result);
}

// Helper functions

function generateAuthorizationId(): string {
  return `auth_${Date.now()}_${randomBytes(16).toString('hex')}`;
}

function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

function createSignaturePayload(authorization: PaymentAuthorization): string {
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

function signPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Wrapper function to use deferred payment with Faremeter's wrapFetch
 * 
 * Usage:
 * ```typescript
 * import { wrap as wrapFetch } from '@faremeter/fetch';
 * import { createDeferredPaymentHandler } from './deferred-payment';
 * 
 * const handler = createDeferredPaymentHandler({
 *   wallet: myWallet,
 *   facilitatorConfig: config
 * });
 * 
 * const fetchWithDeferred = wrapFetch(fetch, {
 *   handlers: [handler]
 * });
 * ```
 */
export function wrapWithDeferredPayment(
  fetchFn: typeof fetch,
  handler: ReturnType<typeof createDeferredPaymentHandler>
) {
  return async (url: string | URL, init?: RequestInit) => {
    // First attempt without payment
    let response = await fetchFn(url, init);
    
    // If 402 Payment Required, handle with deferred payment
    if (response.status === 402) {
      console.log('💳 [Deferred Plugin] 402 Payment Required detected');
      
      // Parse payment requirements from response
      const paymentRequired = await parse402Response(response);
      
      if (paymentRequired) {
        // Create authorization
        const result = await handler.handlePayment({
          amount: paymentRequired.amount,
          currency: paymentRequired.currency,
          merchant: paymentRequired.merchant,
          toolName: paymentRequired.toolName || 'unknown'
        });
        
        if (result.success && result.authorization) {
          // Retry request with authorization header
          const authHeader = handler.encodeAuthorization(result.authorization);
          
          const retryInit = {
            ...init,
            headers: {
              ...init?.headers,
              'X-PAYMENT-AUTH': authHeader,
              'X-DEFERRED-PAYMENT': 'true'
            }
          };
          
          response = await fetchFn(url, retryInit);
        }
      }
    }
    
    return response;
  };
}

/**
 * Parse 402 Payment Required response
 */
async function parse402Response(response: Response): Promise<{
  amount: string;
  currency: string;
  merchant: string;
  toolName?: string;
} | null> {
  try {
    // Try to parse x402 standard response
    const paymentHeader = response.headers.get('X-PAYMENT-REQUIRED');
    
    if (paymentHeader) {
      const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
      return {
        amount: decoded.amount || '0.001',
        currency: decoded.currency || 'USDC',
        merchant: decoded.merchant || decoded.recipient || '',
        toolName: decoded.toolName
      };
    }
    
    // Fallback: parse from response body
    const body = await response.json();
    if (body.amount && body.currency) {
      return {
        amount: body.amount,
        currency: body.currency,
        merchant: body.merchant || body.recipient || '',
        toolName: body.toolName
      };
    }
    
    return null;
  } catch (error) {
    console.error('⚠️ [Deferred Plugin] Failed to parse 402 response:', error);
    return null;
  }
}

