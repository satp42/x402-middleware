export interface X402PaymentRequirement {
  needsPayment: true;
  toolName: string;
  apiUrl: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  estimatedCost: {
    amount: string;
    currency: string;
  };
}

// Deferred payment types
export type PaymentMode = 'immediate' | 'deferred' | 'aggregated';
export type AuthorizationStatus = 'pending' | 'validated' | 'settled' | 'disputed' | 'expired';

export interface DeferredTerms {
  maxRequests: number;
  maxAmount: string;
  settlementPeriod: number; // hours
  escrowAmount?: string;
  currency: string;
}

export interface DeferredPaymentRequirement extends X402PaymentRequirement {
  paymentMode: PaymentMode;
  deferredTerms?: DeferredTerms;
  validationRequired?: boolean;
}

export interface PaymentAuthorization {
  id: string;
  agentAddress: string;
  merchantAddress: string;
  toolName: string;
  amount: string;
  currency: string;
  timestamp: number;
  expiresAt: number;
  signature: string;
  nonce: string;
  status: AuthorizationStatus;
  dataHash?: string;
  metadata?: Record<string, any>;
}

export interface SettlementBatch {
  id: string;
  agentAddress: string;
  merchantAddress: string;
  authorizations: PaymentAuthorization[];
  totalAmount: string;
  currency: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: number;
  settledAt?: number;
  transactionSignature?: string;
  error?: string;
}

export interface DisputeRecord {
  id: string;
  authorizationId: string;
  agentAddress: string;
  merchantAddress: string;
  reason: string;
  status: 'pending' | 'investigating' | 'resolved' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
  resolution?: string;
  evidence?: {
    dataHash?: string;
    validationErrors?: string[];
    additionalInfo?: Record<string, any>;
  };
}

export interface SettlementThreshold {
  amountThreshold: string; // e.g., "1.00" USDC
  timeThreshold: number; // seconds
  countThreshold: number; // number of requests
}

export interface FacilitatorConfig {
  url: string;
  settlementThresholds: SettlementThreshold;
  enableDisputes: boolean;
  autoSettlement: boolean;
}

export interface NansenHistoricalBalancesRequest {
  address: string;
  chain: string;
  date: {
    from: string;
    to: string;
  };
  pagination: {
    page: number;
    per_page: number;
  };
}

export interface NansenSmartMoneyNetflowRequest {
  chains: string[];
  pagination: {
    page: number;
    per_page: number;
  };
}

export interface NansenSmartMoneyHoldingsRequest {
  chains: string[];
  pagination: {
    page: number;
    per_page: number;
  };
}

export interface NansenSmartMoneyDexTradesRequest {
  chains: string[];
  pagination: {
    page: number;
    per_page: number;
  };
}

export interface NansenSmartMoneyJupiterDcasRequest {
  pagination: {
    page: number;
    per_page: number;
  };
}

export interface NansenCurrentBalanceRequest {
  address: string;
  chain: string;
  hide_spam_token: boolean;
  pagination: { page: number; per_page: number };
}

export interface NansenTransactionsRequest {
  address: string;
  chain: string;
  date: { from: string; to: string };
  hide_spam_token: boolean;
  pagination: { page: number; per_page: number };
}

export interface NansenCounterpartiesRequest {
  wallet_address: string;
  chain: string;
  pagination: { page: number; per_page: number };
}

export interface NansenRelatedWalletsRequest {
  wallet_address: string;
  chain: string;
  pagination: { page: number; per_page: number };
}

export interface NansenPnlSummaryRequest {
  address: string;
  chain: string;
  date: { from: string; to: string };
}

export interface NansenPnlRequest {
  wallet_address: string;
  chain: string;
  pagination: { page: number; per_page: number };
}

export interface NansenLabelsRequest {
  wallet_address: string;
  chain: string;
}

export interface NansenTokenScreenerRequest {
  chains: string[];
  pagination: { page: number; per_page: number };
}

export interface NansenFlowIntelligenceRequest {
  token_address: string;
  chain: string;
}

export interface NansenHoldersRequest {
  token_address: string;
  chain: string;
  pagination: { page: number; per_page: number };
}

export interface NansenFlowsRequest {
  token_address: string;
  chain: string;
  date: { from: string; to: string };
}

export interface NansenWhoBoughtSoldRequest {
  token_address: string;
  chain: string;
  date: { from: string; to: string };
  pagination: { page: number; per_page: number };
}

export interface NansenTokenDexTradesRequest {
  token_address: string;
  chain: string;
  date: { from: string; to: string };
  pagination: { page: number; per_page: number };
}

export interface NansenTokenTransfersRequest {
  token_address: string;
  chain: string;
  date: { from: string; to: string };
  pagination: { page: number; per_page: number };
}

export interface NansenTokenJupiterDcasRequest {
  token_address: string;
  chain: string;
  pagination: { page: number; per_page: number };
}

export interface NansenPnlLeaderboardRequest {
  token_address: string;
  chain: string;
  date: { from: string; to: string };
  pagination: { page: number; per_page: number };
}

export interface NansenPortfolioRequest {
  wallet_address: string;
  chains: string[];
}

